/* ahura-api: Cloudflare Worker backend for the ahura.dev static site.
 *
 * Public API:
 *   POST /api/analytics      anonymous page-view ingestion
 *   POST /api/subscribe      newsletter signup (double opt-in, pending until confirmed)
 *   GET  /api/confirm        confirm a subscription via emailed token
 *   GET  /api/unsubscribe    unsubscribe via emailed token
 *
 * Admin API (requires Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /api/admin/stats
 *   GET  /api/admin/analytics?days=7|30
 *   GET  /api/admin/subscribers?status=&q=&page=&per_page=
 *   GET  /api/admin/subscribers/export            (CSV download)
 *   POST /api/admin/subscribers/:id/unsubscribe
 *   POST /api/admin/subscribers/:id/resend        (resend confirmation; 409 until a mail provider exists)
 *   DELETE /api/admin/subscribers/:id
 *   GET  /api/admin/campaigns
 *   POST /api/admin/campaigns
 *   PUT  /api/admin/campaigns/:id
 *   POST /api/admin/campaigns/:id/test
 *   POST /api/admin/campaigns/:id/send
 *   GET  /api/admin/health
 *
 * Email sending is adapter-based. With EMAIL_PROVIDER=none (default) the
 * subscription workflow stores everything and reports email_sent=false;
 * nothing is ever reported as delivered unless a provider really sent it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEVICES = new Set(["desktop", "mobile", "tablet", "unknown"]);
const SUB_STATUSES = new Set(["pending_confirmation", "confirmed", "unsubscribed", "bounced"]);
const CAMPAIGN_STATUSES = new Set(["draft", "sending", "sent", "failed"]);
const CONFIRM_TTL_SEC = 48 * 3600;

/* ---------------- utilities ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function err(message, status = 400, code = null) {
  return json({ success: false, error: message, ...(code ? { code } : {}) }, status);
}

function timingSafeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomTokenHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
}

function allowedOrigins(env) {
  return String(env.SITE_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(req, env) {
  const origin = req.headers.get("origin");
  const headers = {};
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function handleOptions(req, env) {
  const headers = {
    ...corsHeaders(req, env),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  return new Response(null, { status: 204, headers });
}

function withCors(res, req, env) {
  const h = corsHeaders(req, env);
  for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
  return res;
}

async function readJson(req, maxBytes = 65536) {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("body too large");
  if (!text) return {};
  return JSON.parse(text);
}

/* Sliding-window rate limiter backed by D1. */
async function checkRateLimit(db, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first();
  if (!row || row.window_start !== windowStart) {
    await db
      .prepare("INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
      .bind(key, windowStart)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return true;
}

async function audit(db, action, detail) {
  try {
    await db
      .prepare("INSERT INTO audit_log (action, detail) VALUES (?, ?)")
      .bind(action, detail ? String(detail).slice(0, 2000) : null)
      .run();
  } catch {
    /* audit must never break the request */
  }
}

function requireAdmin(req, env) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 && timingSafeEqual(token, env.ADMIN_TOKEN || "");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

function cleanPath(path) {
  let p = String(path || "").slice(0, 500);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h !== -1) p = p.slice(0, h);
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().slice(0, 253);
  } catch {
    return null;
  }
}

/* ---------------- email provider adapter ---------------- */

const mailProviders = {
  none: {
    name: "none",
    canSend: false,
    async send() {
      throw new Error("email_provider_not_configured");
    },
  },
  /* Future providers (resend, postmark, ...) plug in here with the same
   * interface: { name, canSend, async send({to, subject, html, text}) }.
   * Credentials always come from Worker secrets, never from the repo. */
};

function mailProvider(env) {
  const name = String(env.EMAIL_PROVIDER || "none").toLowerCase();
  return mailProviders[name] || mailProviders.none;
}

/* ---------------- public: analytics ---------------- */

async function handleAnalytics(req, env) {
  const db = env.DB;
  const ip = clientIp(req);
  if (!(await checkRateLimit(db, `analytics:${ip}`, 300, 3600))) {
    return err("rate_limited", 429, "rate_limited");
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return err("invalid_json", 400, "invalid_json");
  }

  const eventId = String(body.event_id || "").slice(0, 64);
  const sessionId = String(body.session_id || "").slice(0, 64);
  const path = cleanPath(body.path);
  const device = DEVICES.has(body.device) ? body.device : "unknown";
  const referrerDomain = body.referrer ? domainOf(body.referrer) : null;
  const utm = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    if (body[k]) utm[k] = String(body[k]).slice(0, 120);
  }

  if (!/^[0-9a-fA-F-]{8,64}$/.test(eventId)) return err("invalid_event_id", 400, "invalid_event");
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return err("invalid_session_id", 400, "invalid_event");
  if (path.length < 1) return err("invalid_path", 400, "invalid_event");

  try {
    await db
      .prepare(
        `INSERT INTO analytics_events
         (event_id, session_id, path, referrer_domain, utm_source, utm_medium, utm_campaign, device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        eventId,
        sessionId,
        path,
        referrerDomain,
        utm.utm_source || null,
        utm.utm_medium || null,
        utm.utm_campaign || null,
        device
      )
      .run();
  } catch (e) {
    if (String(e && e.message).includes("UNIQUE")) {
      return json({ success: true, deduplicated: true }); // already counted
    }
    throw e;
  }
  return json({ success: true });
}

/* ---------------- public: newsletter subscribe ---------------- */

async function handleSubscribe(req, env) {
  const db = env.DB;
  const ip = clientIp(req);
  if (!(await checkRateLimit(db, `subscribe:ip:${ip}`, 10, 3600))) {
    return err("rate_limited", 429, "rate_limited");
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return err("invalid_json", 400, "invalid_json");
  }

  const email = normalizeEmail(body.email);
  if (!validEmail(email)) return err("invalid_email", 400, "invalid_email");
  if (!(await checkRateLimit(db, `subscribe:email:${email}`, 3, 3600))) {
    return err("rate_limited", 429, "rate_limited");
  }
  const source = String(body.source || "website").slice(0, 120);

  const existing = await db
    .prepare("SELECT id, status FROM subscribers WHERE email_norm = ?")
    .bind(email)
    .first();

  if (existing && existing.status === "confirmed") {
    return json({ success: true, status: "already_subscribed" });
  }
  if (existing && existing.status === "unsubscribed") {
    // Never silently override an unsubscribe. The owner can remove the record first.
    await audit(db, "subscribe_blocked_unsubscribed", email);
    return err("previously_unsubscribed", 409, "previously_unsubscribed");
  }

  const now = utcNow();
  let subscriberId;
  if (existing) {
    subscriberId = existing.id;
    await db
      .prepare("UPDATE subscribers SET status = 'pending_confirmation', source = ?, updated_at = ? WHERE id = ?")
      .bind(source, now, subscriberId)
      .run();
    await db.prepare("DELETE FROM email_tokens WHERE subscriber_id = ? AND used_at IS NULL").bind(subscriberId).run();
  } else {
    const res = await db
      .prepare(
        `INSERT INTO subscribers (email, email_norm, status, source, consent_at)
         VALUES (?, ?, 'pending_confirmation', ?, ?)`
      )
      .bind(body.email.trim(), email, source, now)
      .run();
    subscriberId = res.meta.last_row_id;
  }

  const token = randomTokenHex(32);
  const tokenHash = await sha256hex(token);
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await db
    .prepare(
      `INSERT INTO email_tokens (subscriber_id, token_hash, purpose, expires_at)
       VALUES (?, ?, 'confirm', ?)`
    )
    .bind(subscriberId, tokenHash, expiresAt)
    .run();

  const provider = mailProvider(env);
  let emailSent = false;
  let emailError = null;
  if (provider.canSend) {
    const siteUrl = String(env.SITE_URL || "").replace(/\/$/, "");
    const confirmUrl = `${req.url.split("/api/")[0]}/api/confirm?token=${token}`;
    try {
      await provider.send({
        to: email,
        subject: "Confirm your newsletter subscription",
        html: `<p>Please confirm your subscription by clicking the link below:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
        text: `Please confirm your subscription: ${confirmUrl}`,
      });
      emailSent = true;
    } catch (e) {
      emailError = String((e && e.message) || e).slice(0, 300);
    }
  }

  await audit(db, "subscribe", `${email} -> pending_confirmation (email_sent=${emailSent})`);
  return json({
    success: true,
    status: "pending_confirmation",
    email_sent: emailSent,
    provider: provider.name,
    ...(emailError ? { email_error: emailError } : {}),
  });
}

/* ---------------- public: confirm / unsubscribe ---------------- */

function resultPage(title, message, siteUrl) {
  const safeTitle = title.replace(/</g, "&lt;");
  const safeMsg = message.replace(/</g, "&lt;");
  const home = String(siteUrl || "/").replace(/"/g, "");
  return new Response(
    `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{font-family:system-ui,sans-serif;background:#f7efe4;color:#2e2b22;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.card{background:#fffdf8;border:1px solid #e0d9c8;border-radius:12px;padding:40px;max-width:480px;text-align:center}h1{font-size:1.4rem;margin:0 0 12px}a{color:#5f5b52}</style></head><body><div class="card"><h1>${safeTitle}</h1><p>${safeMsg}</p><p><a href="${home}">بازگشت به وبلاگ</a></p></div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function findValidToken(db, token, purpose) {
  if (!token || token.length < 32 || token.length > 128) return null;
  const tokenHash = await sha256hex(token);
  const row = await db
    .prepare(
      `SELECT t.id, t.subscriber_id, t.expires_at, t.used_at, s.email
       FROM email_tokens t JOIN subscribers s ON s.id = t.subscriber_id
       WHERE t.token_hash = ? AND t.purpose = ?`
    )
    .bind(tokenHash, purpose)
    .first();
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

async function handleConfirm(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const row = await findValidToken(db, token, "confirm");
  const siteUrl = env.SITE_URL || "/";
  if (!row) {
    return resultPage("Invalid or expired link", "This confirmation link is invalid or has expired. Please subscribe again.", siteUrl);
  }
  const now = utcNow();
  await db.batch([
    db.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.subscriber_id),
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").bind(now, row.id),
  ]);
  await audit(db, "confirm", row.email);
  return resultPage("Subscription confirmed", "Your newsletter subscription is now active. Welcome aboard!", siteUrl);
}

async function handleUnsubscribe(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const siteUrl = env.SITE_URL || "/";
  // Unsubscribe links carry purpose=unsubscribe tokens; also accept confirm tokens for convenience.
  let row = await findValidToken(db, token, "unsubscribe");
  if (!row) row = await findValidToken(db, token, "confirm");
  if (!row) {
    return resultPage("Invalid or expired link", "This unsubscribe link is invalid or has expired.", siteUrl);
  }
  const now = utcNow();
  await db.batch([
    db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.subscriber_id),
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").bind(now, row.id),
  ]);
  await audit(db, "unsubscribe", row.email);
  return resultPage("Unsubscribed", "You have been unsubscribed. You will not receive further newsletters.", siteUrl);
}

/* ---------------- admin: analytics queries ---------------- */

async function adminStats(db) {
  const q = async (sql, ...params) => (await db.prepare(sql).bind(...params).first()) || {};
  const today = (await q("SELECT COUNT(*) c FROM analytics_events WHERE date(created_at) = date('now')")).c || 0;
  const d7 = (await q("SELECT COUNT(*) c FROM analytics_events WHERE created_at >= datetime('now','-7 days')")).c || 0;
  const d30 = (await q("SELECT COUNT(*) c FROM analytics_events WHERE created_at >= datetime('now','-30 days')")).c || 0;
  const sessions = (await q("SELECT COUNT(DISTINCT session_id) c FROM analytics_events WHERE created_at >= datetime('now','-30 days')")).c || 0;
  const confirmed = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='confirmed'")).c || 0;
  const pending = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='pending_confirmation'")).c || 0;
  const unsub = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='unsubscribed'")).c || 0;
  return { views_today: today, views_7d: d7, views_30d: d30, sessions_30d: sessions, subscribers_confirmed: confirmed, subscribers_pending: pending, subscribers_unsubscribed: unsub };
}

async function adminAnalytics(db, days) {
  days = [7, 30, 90].includes(days) ? days : 30;
  const daily = await db
    .prepare(
      `SELECT date(created_at) d, COUNT(*) views, COUNT(DISTINCT session_id) sessions
       FROM analytics_events WHERE created_at >= datetime('now', ?)
       GROUP BY d ORDER BY d`
    )
    .bind(`-${days} days`)
    .all();
  const pages = await db
    .prepare(
      `SELECT path, COUNT(*) views, COUNT(DISTINCT session_id) sessions
       FROM analytics_events WHERE created_at >= datetime('now', ?)
       GROUP BY path ORDER BY views DESC LIMIT 15`
    )
    .bind(`-${days} days`)
    .all();
  const referrers = await db
    .prepare(
      `SELECT COALESCE(referrer_domain,'(direct)') ref, COUNT(*) views
       FROM analytics_events WHERE created_at >= datetime('now', ?)
       GROUP BY ref ORDER BY views DESC LIMIT 15`
    )
    .bind(`-${days} days`)
    .all();
  const devices = await db
    .prepare(
      `SELECT device, COUNT(*) views FROM analytics_events
       WHERE created_at >= datetime('now', ?) GROUP BY device`
    )
    .bind(`-${days} days`)
    .all();
  return {
    days,
    daily: daily.results || [],
    top_pages: pages.results || [],
    referrers: referrers.results || [],
    devices: devices.results || [],
  };
}

/* ---------------- admin: subscribers ---------------- */

async function adminSubscribers(db, url) {
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(5, parseInt(url.searchParams.get("per_page") || "20", 10) || 20));
  const where = [];
  const params = [];
  if (status && SUB_STATUSES.has(status)) {
    where.push("status = ?");
    params.push(status);
  }
  if (q) {
    where.push("email_norm LIKE ?");
    params.push(`%${q.toLowerCase().replace(/[%_]/g, "")}%`);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (await db.prepare(`SELECT COUNT(*) c FROM subscribers ${whereSql}`).bind(...params).first()).c || 0;
  const rows = await db
    .prepare(
      `SELECT id, email, status, source, consent_at, confirmed_at, unsubscribed_at, created_at
       FROM subscribers ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, perPage, (page - 1) * perPage)
    .all();
  return { total, page, per_page: perPage, subscribers: rows.results || [] };
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------------- admin: campaigns ---------------- */

async function campaignRecipientCount(db) {
  const row = await db.prepare("SELECT COUNT(*) c FROM subscribers WHERE status='confirmed'").first();
  return row.c || 0;
}

/* ---------------- router ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return handleOptions(req, env);
    const cors = (res) => withCors(res, req, env);

    try {
      /* public */
      if (path === "/api/analytics" && req.method === "POST") return cors(await handleAnalytics(req, env));
      if (path === "/api/subscribe" && req.method === "POST") return cors(await handleSubscribe(req, env));
      if (path === "/api/confirm" && req.method === "GET") return await handleConfirm(req, env);
      if (path === "/api/unsubscribe" && req.method === "GET") return await handleUnsubscribe(req, env);

      /* admin */
      if (path.startsWith("/api/admin/")) {
        const ip = clientIp(req);
        if (!(await checkRateLimit(env.DB, `admin:${ip}`, 120, 60))) {
          return cors(err("rate_limited", 429, "rate_limited"));
        }
        if (!requireAdmin(req, env)) {
          await audit(env.DB, "admin_auth_failed", ip);
          return cors(err("unauthorized", 401, "unauthorized"));
        }
        return cors(await handleAdmin(req, env, path, url));
      }

      if (path === "/" || path === "/api" || path === "/api/") {
        return cors(json({ success: true, service: "ahura-api", version: "1.0.0" }));
      }
      return cors(err("not_found", 404, "not_found"));
    } catch (e) {
      return cors(err("internal_error", 500));
    }
  },

  /* Daily maintenance: purge expired tokens and stale rate-limit rows. */
  async scheduled(event, env) {
    const db = env.DB;
    const now = utcNow();
    await db.prepare("DELETE FROM email_tokens WHERE used_at IS NOT NULL AND used_at < datetime('now','-30 days')").run();
    await db.prepare("DELETE FROM email_tokens WHERE used_at IS NULL AND expires_at < datetime('now','-7 days')").run();
    await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400).run();
    await audit(db, "scheduled_cleanup", now);
  },
};

async function handleAdmin(req, env, path, url) {
  const db = env.DB;
  const seg = path.split("/").filter(Boolean); // ['api','admin',...]

  /* GET /api/admin/stats */
  if (seg.length === 3 && seg[2] === "stats" && req.method === "GET") {
    return json({ success: true, stats: await adminStats(db) });
  }

  /* GET /api/admin/health */
  if (seg.length === 3 && seg[2] === "health" && req.method === "GET") {
    const provider = mailProvider(env);
    const tables = {};
    for (const t of ["subscribers", "email_tokens", "campaigns", "analytics_events", "audit_log"]) {
      tables[t] = ((await db.prepare(`SELECT COUNT(*) c FROM ${t}`).first()).c || 0);
    }
    return json({
      success: true,
      health: {
        provider: provider.name,
        email_sending: provider.canSend,
        tables,
        time: utcNow(),
      },
    });
  }

  /* GET /api/admin/analytics */
  if (seg.length === 3 && seg[2] === "analytics" && req.method === "GET") {
    const days = parseInt(url.searchParams.get("days") || "30", 10) || 30;
    return json({ success: true, analytics: await adminAnalytics(db, days) });
  }

  /* subscribers */
  if (seg[2] === "subscribers") {
    if (seg.length === 3 && req.method === "GET") {
      return json({ success: true, ...(await adminSubscribers(db, url)) });
    }
    if (seg.length === 4 && seg[3] === "export" && req.method === "GET") {
      const status = url.searchParams.get("status");
      const where = status && SUB_STATUSES.has(status) ? "WHERE status = ?" : "";
      const params = where ? [status] : [];
      const rows = await db
        .prepare(`SELECT email, status, source, consent_at, confirmed_at, unsubscribed_at, created_at FROM subscribers ${where} ORDER BY id`)
        .bind(...params)
        .all();
      const lines = ["email,status,source,consent_at,confirmed_at,unsubscribed_at,created_at"];
      for (const r of rows.results || []) {
        lines.push([r.email, r.status, r.source, r.consent_at, r.confirmed_at, r.unsubscribed_at, r.created_at].map(csvEscape).join(","));
      }
      await audit(db, "subscribers_export", `status=${status || "all"} count=${(rows.results || []).length}`);
      return new Response("\uFEFF" + lines.join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=subscribers.csv",
        },
      });
    }
    const id = parseInt(seg[3], 10);
    if (Number.isInteger(id) && id > 0) {
      if (seg.length === 5 && seg[4] === "unsubscribe" && req.method === "POST") {
        const now = utcNow();
        const r = await db
          .prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=?, updated_at=? WHERE id=? AND status != 'unsubscribed'")
          .bind(now, now, id)
          .run();
        await audit(db, "admin_unsubscribe", `id=${id}`);
        return json({ success: true, updated: r.meta.changes > 0 });
      }
      if (seg.length === 5 && seg[4] === "resend" && req.method === "POST") {
        const sub = await db.prepare("SELECT id, email, email_norm, status FROM subscribers WHERE id = ?").bind(id).first();
        if (!sub) return err("not_found", 404, "not_found");
        if (sub.status !== "pending_confirmation") return err("not_pending", 409, "not_pending");
        const provider = mailProvider(env);
        if (!provider.canSend) {
          return err("email_provider_not_configured", 409, "email_provider_not_configured");
        }
        return err("resend_failed", 500);
      }
      if (seg.length === 4 && req.method === "DELETE") {
        await db.batch([
          db.prepare("DELETE FROM email_tokens WHERE subscriber_id = ?").bind(id),
          db.prepare("DELETE FROM subscribers WHERE id = ?").bind(id),
        ]);
        await audit(db, "admin_delete_subscriber", `id=${id}`);
        return json({ success: true });
      }
    }
    return err("not_found", 404, "not_found");
  }

  /* campaigns */
  if (seg[2] === "campaigns") {
    if (seg.length === 3 && req.method === "GET") {
      const rows = await db
        .prepare("SELECT id, title, subject, status, recipient_count, sent_count, provider, provider_ref, error, created_at, updated_at, sent_at FROM campaigns ORDER BY id DESC")
        .all();
      return json({ success: true, campaigns: rows.results || [] });
    }
    if (seg.length === 3 && req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return err("invalid_json", 400, "invalid_json");
      }
      const title = String(body.title || "").slice(0, 200);
      const subject = String(body.subject || "").slice(0, 200);
      if (!title || !subject) return err("title_and_subject_required", 400, "validation");
      const res = await db
        .prepare("INSERT INTO campaigns (title, subject, body_html, body_text) VALUES (?, ?, ?, ?)")
        .bind(title, subject, String(body.body_html || "").slice(0, 500000), String(body.body_text || "").slice(0, 200000))
        .run();
      await audit(db, "campaign_create", `id=${res.meta.last_row_id} title=${title}`);
      return json({ success: true, id: res.meta.last_row_id }, 201);
    }
    const id = parseInt(seg[3], 10);
    if (Number.isInteger(id) && id > 0) {
      if (seg.length === 4 && req.method === "PUT") {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return err("invalid_json", 400, "invalid_json");
        }
        const cur = await db.prepare("SELECT status FROM campaigns WHERE id = ?").bind(id).first();
        if (!cur) return err("not_found", 404, "not_found");
        if (cur.status !== "draft") return err("only_drafts_editable", 409, "invalid_state");
        const now = utcNow();
        await db
          .prepare("UPDATE campaigns SET title=?, subject=?, body_html=?, body_text=?, updated_at=? WHERE id=?")
          .bind(
            String(body.title || "").slice(0, 200),
            String(body.subject || "").slice(0, 200),
            String(body.body_html || "").slice(0, 500000),
            String(body.body_text || "").slice(0, 200000),
            now,
            id
          )
          .run();
        await audit(db, "campaign_update", `id=${id}`);
        return json({ success: true });
      }
      if (seg.length === 5 && seg[4] === "test" && req.method === "POST") {
        const provider = mailProvider(env);
        if (!provider.canSend) return err("email_provider_not_configured", 409, "email_provider_not_configured");
        return err("not_implemented", 501);
      }
      if (seg.length === 5 && seg[4] === "send" && req.method === "POST") {
        const provider = mailProvider(env);
        if (!provider.canSend) {
          return err("email_provider_not_configured", 409, "email_provider_not_configured");
        }
        return err("not_implemented", 501);
      }
    }
    return err("not_found", 404, "not_found");
  }

  return err("not_found", 404, "not_found");
}
