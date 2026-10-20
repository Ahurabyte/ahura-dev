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
  // Note: vars set via the API multipart upload are silently dropped by
  // Cloudflare (verified 2026-10-20), so keep a hardcoded fallback.
  const fromEnv = String(env.SITE_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  return ["https://adsrdsr2.github.io"];
}

function siteUrl(env) {
  return env.SITE_URL || "https://adsrdsr2.github.io/ahura-dev";
}

function emailProvider(env) {
  const configured = String(env.EMAIL_PROVIDER || "none").toLowerCase();
  if (configured !== "none") return configured;
  // The Cloudflare deploy API has silently dropped `vars` before; when the
  // Resend secret is present the intent is unambiguous.
  return env.RESEND_API_KEY ? "resend" : "none";
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

/* Obvious-bot detection: only well-known automation/crawler signatures.
 * Deliberately conservative — a real browser UA never matches these. */
const BOT_UA_RE =
  /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|webdriver|lighthouse|curl|wget|scrapy|python-requests|python-urllib|go-http-client|java\/|okhttp|axios|node-fetch|httpclient|facebookexternalhit|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|dataforseo/i;

function isObviousBot(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return true; // real browsers always send a UA
  return BOT_UA_RE.test(ua);
}

/* ---------------- email provider adapter ---------------- */

/* Providers plug in here with the same interface:
 * { name, canSend, async send({to, subject, html, text}) }.
 * An entry may be a factory `(env) => provider` when it needs secrets;
 * credentials always come from Worker secrets, never from the repo. */
const mailProviders = {
  none: {
    name: "none",
    canSend: false,
    async send() {
      throw new Error("email_provider_not_configured");
    },
  },
  resend: (env) => ({
    name: "resend",
    canSend: Boolean(env.RESEND_API_KEY),
    async send({ to, subject, html, text }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "Ahura Blog <newsletter@ahura.dev>",
          to,
          subject,
          html,
          text,
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = String((body && (body.message || body.name)) || "").slice(0, 200);
        } catch {
          /* keep the HTTP status only */
        }
        throw new Error(`resend_http_${res.status}${detail ? `: ${detail}` : ""}`);
      }
      return res.json();
    },
  }),
};

function mailProvider(env) {
  const name = String(emailProvider(env)).toLowerCase();
  const entry = mailProviders[name] || mailProviders.none;
  return typeof entry === "function" ? entry(env) : entry;
}

/* ---------------- public: analytics ---------------- */

async function handleAnalytics(req, env) {
  const db = env.DB;
  const ip = clientIp(req);
  if (!(await checkRateLimit(db, `analytics:${ip}`, 300, 3600))) {
    return err("rate_limited", 429, "rate_limited");
  }
  // Drop obvious bots before doing any storage work. We answer "success" so
  // probes learn nothing; nothing is recorded.
  if (isObviousBot(req.headers.get("user-agent"))) {
    return json({ success: true, filtered: "bot" });
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return err("invalid_json", 400, "invalid_json");
  }

  const eventId = String(body.event_id || "").slice(0, 64);
  const sessionId = String(body.session_id || "").slice(0, 64);
  const visitorId = String(body.visitor_id || "").slice(0, 64);
  const path = cleanPath(body.path);
  const device = DEVICES.has(body.device) ? body.device : "unknown";
  const referrerDomain = body.referrer ? domainOf(body.referrer) : null;
  const utm = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    if (body[k]) utm[k] = String(body[k]).slice(0, 120);
  }

  if (!/^[0-9a-fA-F-]{8,64}$/.test(eventId)) return err("invalid_event_id", 400, "invalid_event");
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return err("invalid_session_id", 400, "invalid_event");
  if (visitorId && !/^[0-9a-fA-F-]{8,64}$/.test(visitorId)) return err("invalid_visitor_id", 400, "invalid_event");
  if (path.length < 1) return err("invalid_path", 400, "invalid_event");

  try {
    await db
      .prepare(
        `INSERT INTO analytics_events
         (event_id, session_id, visitor_id, path, referrer_domain, utm_source, utm_medium, utm_campaign, device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        eventId,
        sessionId,
        visitorId || null,
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
  const home = siteUrl(env);
  if (!row) {
    return resultPage("Invalid or expired link", "This confirmation link is invalid or has expired. Please subscribe again.", home);
  }
  const now = utcNow();
  await db.batch([
    db.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.subscriber_id),
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").bind(now, row.id),
  ]);
  await audit(db, "confirm", row.email);
  return resultPage("Subscription confirmed", "Your newsletter subscription is now active. Welcome aboard!", home);
}

async function handleUnsubscribe(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const home = siteUrl(env);
  // Unsubscribe links carry purpose=unsubscribe tokens; also accept confirm tokens for convenience.
  let row = await findValidToken(db, token, "unsubscribe");
  if (!row) row = await findValidToken(db, token, "confirm");
  if (!row) {
    return resultPage("Invalid or expired link", "This unsubscribe link is invalid or has expired.", home);
  }
  const now = utcNow();
  await db.batch([
    db.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.subscriber_id),
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").bind(now, row.id),
  ]);
  await audit(db, "unsubscribe", row.email);
  return resultPage("Unsubscribed", "You have been unsubscribed. You will not receive further newsletters.", home);
}

/* ---------------- admin: analytics queries ---------------- */

async function adminStats(db) {
  const q = async (sql, ...params) => (await db.prepare(sql).bind(...params).first()) || {};
  const today = (await q("SELECT COUNT(*) c FROM analytics_events WHERE date(created_at) = date('now')")).c || 0;
  const d7 = (await q("SELECT COUNT(*) c FROM analytics_events WHERE created_at >= datetime('now','-7 days')")).c || 0;
  const d30 = (await q("SELECT COUNT(*) c FROM analytics_events WHERE created_at >= datetime('now','-30 days')")).c || 0;
  const sessions = (await q("SELECT COUNT(DISTINCT session_id) c FROM analytics_events WHERE created_at >= datetime('now','-30 days')")).c || 0;
  const visitors = (await q("SELECT COUNT(DISTINCT visitor_id) c FROM analytics_events WHERE created_at >= datetime('now','-30 days') AND visitor_id IS NOT NULL")).c || 0;
  const confirmed = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='confirmed'")).c || 0;
  const pending = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='pending_confirmation'")).c || 0;
  const unsub = (await q("SELECT COUNT(*) c FROM subscribers WHERE status='unsubscribed'")).c || 0;
  return { views_today: today, views_7d: d7, views_30d: d30, sessions_30d: sessions, visitors_30d: visitors, subscribers_confirmed: confirmed, subscribers_pending: pending, subscribers_unsubscribed: unsub };
}

async function adminAnalytics(db, days) {
  days = [7, 30, 90].includes(days) ? days : 30;
  const daily = await db
    .prepare(
      `SELECT date(created_at) d, COUNT(*) views, COUNT(DISTINCT session_id) sessions,
              COUNT(DISTINCT visitor_id) visitors
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

/* ---------------- writing studio: documents ---------------- */

const DOC_TYPES = new Set(["note", "article", "docs", "research", "newsletter"]);
const DOC_STATUSES = new Set(["active", "archived", "trashed"]);
const MAX_REVISIONS = 50;
const REVISION_MIN_INTERVAL_MS = 30 * 60 * 1000;

const IMAGE_TYPES = {
  "image/png": { ext: "png", sigs: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  "image/jpeg": { ext: "jpg", sigs: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  "image/webp": {
    ext: "webp",
    sigs: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  "image/gif": { ext: "gif", sigs: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] },
};
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function cleanTags(tags) {
  return String(tags || "")
    .split(",")
    .map((t) => t.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 20)
    .join(",");
}

function countWords(text) {
  const t = String(text || "");
  if (!t.trim()) return 0;
  // Unicode-aware: count sequences of letters/numbers (works for Persian, English, CJK).
  const m = t.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

async function maybeCreateRevision(db, doc, reason) {
  const last = await db
    .prepare("SELECT id, created_at, markdown_content FROM revisions WHERE document_id = ? ORDER BY id DESC LIMIT 1")
    .bind(doc.id)
    .first();
  const changed = !last || last.markdown_content !== doc.markdown_content;
  if (!changed) return;
  const recentEnough =
    last && Date.now() - new Date(last.created_at).getTime() < REVISION_MIN_INTERVAL_MS;
  if (reason !== "manual" && recentEnough) return;
  await db
    .prepare(
      "INSERT INTO revisions (document_id, title, markdown_content, version, reason) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(doc.id, doc.title, doc.markdown_content, doc.version, reason)
    .run();
  // Keep only the newest MAX_REVISIONS per document.
  await db
    .prepare(
      `DELETE FROM revisions WHERE document_id = ? AND id NOT IN
       (SELECT id FROM revisions WHERE document_id = ? ORDER BY id DESC LIMIT ?)`
    )
    .bind(doc.id, doc.id, MAX_REVISIONS)
    .run();
}

function docRow(r) {
  return {
    id: r.id,
    title: r.title,
    document_type: r.document_type,
    folder_id: r.folder_id,
    status: r.status,
    is_pinned: !!r.is_pinned,
    tags: r.tags,
    version: r.version,
    word_count: r.word_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
    publish_state: r.publish_state || "draft",
    slug: r.slug || null,
    excerpt: r.excerpt || "",
    published_at: r.published_at || null,
    sync_state: r.sync_state || "clean",
    cover_image: r.cover_image || null,
  };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
function validSlug(s) {
  return typeof s === "string" && SLUG_RE.test(s);
}

async function handleDocuments(req, env, seg, url) {
  const db = env.DB;

  /* GET /api/admin/documents — list with search/filter/pagination */
  if (seg.length === 3 && req.method === "GET") {
    const status = url.searchParams.get("status") || "active";
    const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
    const folderId = url.searchParams.get("folder_id");
    const type = url.searchParams.get("type");
    const tag = (url.searchParams.get("tag") || "").trim().slice(0, 60);
    const sort = url.searchParams.get("sort") || "updated";
    const publishState = url.searchParams.get("publish_state");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const perPage = Math.min(100, Math.max(5, parseInt(url.searchParams.get("per_page") || "20", 10) || 20));

    const where = [];
    const params = [];
    if (DOC_STATUSES.has(status)) {
      where.push("d.status = ?");
      params.push(status);
    }
    if (publishState === "draft" || publishState === "published") {
      where.push("d.publish_state = ?");
      params.push(publishState);
    }
    if (folderId === "none") {
      where.push("d.folder_id IS NULL");
    } else if (folderId && /^\d+$/.test(folderId)) {
      where.push("d.folder_id = ?");
      params.push(parseInt(folderId, 10));
    }
    if (type && DOC_TYPES.has(type)) {
      where.push("d.document_type = ?");
      params.push(type);
    }
    if (tag) {
      where.push("(',' || d.tags || ',') LIKE ?");
      params.push(`%,${tag.replace(/[%_,]/g, "")},%`);
    }

    let fromSql, countSql;
    if (q) {
      // Full-text search over title + content; fall back gracefully on bad syntax.
      let fts;
      try {
        fts = q.replace(/"/g, '""');
        fromSql = `documents d JOIN documents_fts f ON f.rowid = d.id`;
        where.push(`documents_fts MATCH ?`);
        params.push(`"${fts}"*`);
      } catch {
        fromSql = `documents d`;
      }
      if (!fromSql) fromSql = `documents d`;
    } else {
      fromSql = `documents d`;
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const order =
      sort === "created" ? "d.created_at DESC" : sort === "title" ? "d.title ASC" : "d.updated_at DESC";
    // Pinned documents first, then the requested sort.
    const orderSql = `d.is_pinned DESC, ${order}`;

    let total = 0;
    try {
      const trow = await db.prepare(`SELECT COUNT(*) c FROM ${fromSql} ${whereSql}`).bind(...params).first();
      total = trow.c || 0;
    } catch {
      return err("search_failed", 400, "search_failed");
    }
    const rows = await db
      .prepare(
        `SELECT d.id, d.title, d.document_type, d.folder_id, d.status, d.is_pinned,
                d.tags, d.version, d.word_count, d.created_at, d.updated_at,
                d.publish_state, d.slug, d.excerpt, d.published_at, d.sync_state, d.cover_image
         FROM ${fromSql} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
      )
      .bind(...params, perPage, (page - 1) * perPage)
      .all();
    return json({
      success: true,
      total,
      page,
      per_page: perPage,
      documents: (rows.results || []).map(docRow),
    });
  }

  /* POST /api/admin/documents — create */
  if (seg.length === 3 && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return err("invalid_json", 400, "invalid_json");
    }
    const title = String(body.title || "Untitled").slice(0, 300) || "Untitled";
    const document_type = DOC_TYPES.has(body.document_type) ? body.document_type : "note";
    const folder_id = body.folder_id != null && /^\d+$/.test(String(body.folder_id)) ? parseInt(body.folder_id, 10) : null;
    if (folder_id) {
      const f = await db.prepare("SELECT id FROM folders WHERE id = ?").bind(folder_id).first();
      if (!f) return err("folder_not_found", 404, "folder_not_found");
    }
    const content = String(body.markdown_content || "").slice(0, 2000000);
    const res = await db
      .prepare(
        `INSERT INTO documents (title, document_type, markdown_content, folder_id, tags, word_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(title, document_type, content, folder_id, cleanTags(body.tags), countWords(content))
      .run();
    const id = res.meta.last_row_id;
    await audit(db, "document_create", `id=${id} title=${title.slice(0, 80)}`);
    const row = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    return json({ success: true, document: { ...docRow(row), markdown_content: row.markdown_content } }, 201);
  }

  const id = parseInt(seg[3], 10);
  if (!Number.isInteger(id) || id <= 0) return err("not_found", 404, "not_found");

  /* GET /api/admin/documents/:id */
  if (seg.length === 4 && req.method === "GET") {
    const row = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    if (!row) return err("not_found", 404, "not_found");
    return json({ success: true, document: { ...docRow(row), markdown_content: row.markdown_content } });
  }

  /* PUT /api/admin/documents/:id — optimistic concurrency via version */
  if (seg.length === 4 && req.method === "PUT") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return err("invalid_json", 400, "invalid_json");
    }
    const clientVersion = parseInt(body.version, 10);
    if (!Number.isInteger(clientVersion)) return err("version_required", 400, "version_required");
    const cur = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    if (cur.version !== clientVersion) {
      return json(
        { success: false, error: "version_conflict", code: "version_conflict", current_version: cur.version },
        409
      );
    }
    const now = utcNow();
    const title = body.title !== undefined ? String(body.title).slice(0, 300) || "Untitled" : cur.title;
    const content = body.markdown_content !== undefined ? String(body.markdown_content).slice(0, 2000000) : cur.markdown_content;
    const folder_id =
      body.folder_id === null || body.folder_id === undefined
        ? cur.folder_id
        : /^\d+$/.test(String(body.folder_id))
          ? parseInt(body.folder_id, 10)
          : cur.folder_id;
    if (body.folder_id !== undefined && body.folder_id !== null && folder_id !== cur.folder_id) {
      const f = await db.prepare("SELECT id FROM folders WHERE id = ?").bind(folder_id).first();
      if (!f) return err("folder_not_found", 404, "folder_not_found");
    }
    const status = body.status !== undefined && DOC_STATUSES.has(body.status) ? body.status : cur.status;
    const is_pinned = body.is_pinned !== undefined ? (body.is_pinned ? 1 : 0) : cur.is_pinned;
    const tags = body.tags !== undefined ? cleanTags(body.tags) : cur.tags;
    // Publishing metadata: slug/excerpt may be edited in any state; the slug
    // must stay a valid URL segment and unique among non-trashed documents.
    let slug = cur.slug;
    if (body.slug !== undefined) {
      const s = String(body.slug || "").trim();
      if (s && !validSlug(s)) return err("invalid_slug", 400, "invalid_slug");
      if (s && s !== cur.slug) {
        const clash = await db
          .prepare("SELECT id FROM documents WHERE slug = ? AND status != 'trashed' AND id != ?")
          .bind(s, id)
          .first();
        if (clash) return err("slug_taken", 409, "slug_taken");
      }
      slug = s || null;
    }
    const excerpt = body.excerpt !== undefined ? String(body.excerpt).slice(0, 400) : cur.excerpt;
    // Cover image: an assets key chosen in the studio, validated against the
    // library so a stale/forged key can't break the site's <img>.
    let cover_image = cur.cover_image ?? null;
    if (body.cover_image !== undefined) {
      const k = body.cover_image === null ? "" : String(body.cover_image).trim();
      if (!k) {
        cover_image = null;
      } else if (!/^[0-9a-f]{32}\.(png|jpg|webp|gif)$/.test(k)) {
        return err("invalid_cover", 400, "invalid_cover");
      } else {
        const a = await db.prepare("SELECT key FROM assets WHERE key = ?").bind(k).first();
        if (!a) return err("cover_not_found", 400, "cover_not_found");
        cover_image = k;
      }
    }
    // Publishing invariant: anything user-visible changing on a published
    // document makes its git copy stale.
    const sync_state =
      cur.publish_state === "published" &&
      (content !== cur.markdown_content || title !== cur.title || tags !== cur.tags || slug !== cur.slug || excerpt !== cur.excerpt || cover_image !== (cur.cover_image ?? null))
        ? "dirty"
        : cur.sync_state;
    const newVersion = cur.version + 1;
    await db
      .prepare(
        `UPDATE documents SET title=?, markdown_content=?, folder_id=?, status=?,
         is_pinned=?, tags=?, version=?, word_count=?, updated_at=?, slug=?, excerpt=?, sync_state=?, cover_image=? WHERE id=?`
      )
      .bind(title, content, folder_id, status, is_pinned, tags, newVersion, countWords(content), now, slug, excerpt, sync_state, cover_image, id)
      .run();
    const updated = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    await maybeCreateRevision(db, updated, body.manual ? "manual" : "auto");
    await audit(db, "document_update", `id=${id} v${newVersion}`);
    return json({ success: true, version: newVersion, updated_at: now });
  }

  /* DELETE /api/admin/documents/:id — soft delete by default, ?permanent=1 for hard */
  if (seg.length === 4 && req.method === "DELETE") {
    const cur = await db.prepare("SELECT publish_state FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    // A published document has a live git copy; unpublish first so the sync
    // can remove the MDX file deterministically.
    if (cur.publish_state === "published") return err("must_unpublish_first", 409, "must_unpublish_first");
    const permanent = url.searchParams.get("permanent") === "1";
    if (permanent) {
      await db.batch([
        db.prepare("DELETE FROM revisions WHERE document_id = ?").bind(id),
        db.prepare("DELETE FROM documents WHERE id = ?").bind(id),
      ]);
      await audit(db, "document_hard_delete", `id=${id}`);
    } else {
      const now = utcNow();
      await db.prepare("UPDATE documents SET status='trashed', updated_at=? WHERE id=?").bind(now, id).run();
      await audit(db, "document_trash", `id=${id}`);
    }
    return json({ success: true });
  }

  /* POST /api/admin/documents/:id/duplicate */
  if (seg.length === 5 && seg[4] === "duplicate" && req.method === "POST") {
    const cur = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    const res = await db
      .prepare(
        `INSERT INTO documents (title, document_type, markdown_content, folder_id, tags, word_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(`${cur.title} (copy)`.slice(0, 300), cur.document_type, cur.markdown_content, cur.folder_id, cur.tags, cur.word_count)
      .run();
    await audit(db, "document_duplicate", `from=${id} to=${res.meta.last_row_id}`);
    return json({ success: true, id: res.meta.last_row_id }, 201);
  }

  /* POST /api/admin/documents/:id/archive | /restore */
  if (seg.length === 5 && (seg[4] === "archive" || seg[4] === "restore") && req.method === "POST") {
    const to = seg[4] === "archive" ? "archived" : "active";
    const now = utcNow();
    const r = await db.prepare("UPDATE documents SET status=?, updated_at=? WHERE id=?").bind(to, now, id).run();
    if (!r.meta.changes) return err("not_found", 404, "not_found");
    await audit(db, `document_${seg[4]}`, `id=${id}`);
    return json({ success: true, status: to });
  }

  /* POST /api/admin/documents/:id/publish — draft -> published (marks git sync dirty) */
  if (seg.length === 5 && seg[4] === "publish" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return err("invalid_json", 400, "invalid_json");
    }
    const cur = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    if (cur.status !== "active") return err("not_active", 400, "not_active");
    if (cur.document_type !== "article") return err("not_an_article", 400, "not_an_article");
    if (!cur.title || !cur.title.trim()) return err("title_required", 400, "title_required");
    if (!cur.markdown_content || !cur.markdown_content.trim()) return err("empty_content", 400, "empty_content");
    const slug = (body.slug !== undefined ? String(body.slug || "") : String(cur.slug || "")).trim();
    if (!validSlug(slug)) return err("invalid_slug", 400, "invalid_slug");
    const clash = await db
      .prepare("SELECT id FROM documents WHERE slug = ? AND status != 'trashed' AND id != ?")
      .bind(slug, id)
      .first();
    if (clash) return err("slug_taken", 409, "slug_taken");
    const excerpt = body.excerpt !== undefined ? String(body.excerpt).slice(0, 400) : String(cur.excerpt || "");
    const now = utcNow();
    const published_at = cur.published_at || now.slice(0, 10);
    await db
      .prepare(
        "UPDATE documents SET publish_state='published', slug=?, excerpt=?, published_at=?, sync_state='dirty', version=version+1, updated_at=? WHERE id=?"
      )
      .bind(slug, excerpt, published_at, now, id)
      .run();
    const snap = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    await maybeCreateRevision(db, snap, "manual");
    await audit(db, "document_publish", `id=${id} slug=${slug}`);
    return json({ success: true, slug, published_at, version: snap.version });
  }

  /* POST /api/admin/documents/:id/unpublish — published -> draft */
  if (seg.length === 5 && seg[4] === "unpublish" && req.method === "POST") {
    const cur = await db.prepare("SELECT publish_state FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    if (cur.publish_state !== "published") return err("not_published", 400, "not_published");
    const now = utcNow();
    await db
      .prepare("UPDATE documents SET publish_state='draft', sync_state='dirty', version=version+1, updated_at=? WHERE id=?")
      .bind(now, id)
      .run();
    await audit(db, "document_unpublish", `id=${id}`);
    const snap = await db.prepare("SELECT version FROM documents WHERE id = ?").bind(id).first();
    return json({ success: true, version: snap.version });
  }

  /* GET /api/admin/documents/:id/revisions */
  if (seg.length === 5 && seg[4] === "revisions" && req.method === "GET") {
    const rows = await db
      .prepare(
        `SELECT id, title, version, reason, created_at,
                substr(markdown_content, 1, 300) AS preview
         FROM revisions WHERE document_id = ? ORDER BY id DESC LIMIT 50`
      )
      .bind(id)
      .all();
    return json({ success: true, revisions: rows.results || [] });
  }

  /* GET /api/admin/documents/:id/revisions/:revId — full revision content */
  if (seg.length === 6 && seg[4] === "revisions" && req.method === "GET") {
    const revId = parseInt(seg[5], 10);
    const rev = await db
      .prepare("SELECT * FROM revisions WHERE id = ? AND document_id = ?")
      .bind(revId, id)
      .first();
    if (!rev) return err("not_found", 404, "not_found");
    return json({
      success: true,
      revision: {
        id: rev.id,
        title: rev.title,
        markdown_content: rev.markdown_content,
        version: rev.version,
        reason: rev.reason,
        created_at: rev.created_at,
      },
    });
  }

  /* POST /api/admin/documents/:id/revisions/:revId/restore */
  if (seg.length === 7 && seg[4] === "revisions" && seg[6] === "restore" && req.method === "POST") {
    const revId = parseInt(seg[5], 10);
    const rev = await db
      .prepare("SELECT * FROM revisions WHERE id = ? AND document_id = ?")
      .bind(revId, id)
      .first();
    if (!rev) return err("not_found", 404, "not_found");
    const cur = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    if (!cur) return err("not_found", 404, "not_found");
    // Snapshot current content first so the restore itself is reversible.
    await maybeCreateRevision(db, cur, "manual");
    const now = utcNow();
    const newVersion = cur.version + 1;
    await db
      .prepare("UPDATE documents SET title=?, markdown_content=?, version=?, word_count=?, updated_at=? WHERE id=?")
      .bind(rev.title, rev.markdown_content, newVersion, countWords(rev.markdown_content), now, id)
      .run();
    const updated = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
    await maybeCreateRevision(db, updated, "manual");
    await audit(db, "document_revision_restore", `id=${id} rev=${revId} v${newVersion}`);
    return json({ success: true, version: newVersion });
  }

  return err("not_found", 404, "not_found");
}

async function handleFolders(req, env, seg) {
  const db = env.DB;
  if (seg.length === 3 && req.method === "GET") {
    const rows = await db
      .prepare(
        `SELECT f.id, f.name, f.parent_id, f.created_at,
                (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status != 'trashed') AS doc_count
         FROM folders f ORDER BY f.name`
      )
      .all();
    return json({ success: true, folders: rows.results || [] });
  }
  if (seg.length === 3 && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return err("invalid_json", 400, "invalid_json");
    }
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return err("name_required", 400, "validation");
    const parent_id = body.parent_id != null && /^\d+$/.test(String(body.parent_id)) ? parseInt(body.parent_id, 10) : null;
    const res = await db.prepare("INSERT INTO folders (name, parent_id) VALUES (?, ?)").bind(name, parent_id).run();
    await audit(db, "folder_create", `id=${res.meta.last_row_id} name=${name}`);
    return json({ success: true, id: res.meta.last_row_id }, 201);
  }
  const id = parseInt(seg[3], 10);
  if (!Number.isInteger(id) || id <= 0) return err("not_found", 404, "not_found");
  if (seg.length === 4 && req.method === "PUT") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return err("invalid_json", 400, "invalid_json");
    }
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return err("name_required", 400, "validation");
    const r = await db.prepare("UPDATE folders SET name=?, updated_at=? WHERE id=?").bind(name, utcNow(), id).run();
    if (!r.meta.changes) return err("not_found", 404, "not_found");
    return json({ success: true });
  }
  if (seg.length === 4 && req.method === "DELETE") {
    await db.batch([
      db.prepare("UPDATE documents SET folder_id = NULL WHERE folder_id = ?").bind(id),
      db.prepare("DELETE FROM folders WHERE id = ?").bind(id),
    ]);
    await audit(db, "folder_delete", `id=${id}`);
    return json({ success: true });
  }
  return err("not_found", 404, "not_found");
}

/* ---------------- writing studio: asset upload ---------------- */

function detectImageType(bytes) {
  outer: for (const [mime, info] of Object.entries(IMAGE_TYPES)) {
    for (const { offset, bytes: sig } of info.sigs) {
      for (let i = 0; i < sig.length; i++) {
        if (bytes[offset + i] !== sig[i]) continue outer;
      }
    }
    return { mime, ext: info.ext };
  }
  return null;
}

function u8ToBase64(u8) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

async function handleUpload(req, env) {
  const db = env.DB;
  const ip = clientIp(req);
  if (!(await checkRateLimit(db, `upload:${ip}`, 200, 3600))) {
    return err("rate_limited", 429, "rate_limited");
  }
  let form;
  try {
    form = await req.formData();
  } catch {
    return err("invalid_form", 400, "invalid_form");
  }
  const files = [];
  for (const v of form.getAll("file[]")) {
    if (typeof v !== "string") files.push(v);
  }
  if (!files.length) return err("no_files", 400, "no_files");
  if (files.length > 5) return err("too_many_files", 400, "too_many_files");

  const base = req.url.split("/api/")[0];
  const out = [];
  for (const file of files) {
    const size = file.size;
    if (size <= 0 || size > MAX_UPLOAD_BYTES) {
      return err("file_too_large", 413, "file_too_large");
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const detected = detectImageType(buf);
    if (!detected) {
      return err("invalid_image", 400, "invalid_image");
    }
    const key = `${randomTokenHex(16)}.${detected.ext}`;
    // Library metadata: the file's own name by default; batch importers can
    // override via form fields so the studio picker shows meaningful labels.
    const assetName = String(form.get("asset_name") || file.name || "")
      .split(/[\\/]/)
      .pop()
      .slice(0, 120);
    const assetCategory = String(form.get("asset_category") || "").slice(0, 60);
    // Stored as base64 TEXT: D1 BLOB bind/read round-trips are unreliable,
    // while TEXT is deterministic. (+33% size; acceptable at this scale.)
    await db
      .prepare("INSERT INTO assets (key, content_type, size, data, name, category) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(key, detected.mime, size, u8ToBase64(buf), assetName, assetCategory)
      .run();
    out.push({ name: file.name, url: `${base}/api/assets/${key}`, key });
  }
  await audit(db, "asset_upload", `count=${out.length}`);
  return json({ success: true, files: out });
}

async function handleAsset(req, env, key) {
  if (!/^[0-9a-f]{32}\.(png|jpg|webp|gif)$/.test(key)) {
    return new Response("not found", { status: 404 });
  }
  const row = await env.DB.prepare("SELECT content_type, data, size FROM assets WHERE key = ?").bind(key).first();
  if (!row || typeof row.data !== "string") return new Response("not found", { status: 404 });
  return new Response(base64ToU8(row.data), {
    headers: {
      "content-type": row.content_type,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/* GET /api/admin/assets — the studio image library (metadata only; the
 * image bytes stay behind the public /api/assets/:key route). */
async function handleAssetsList(req, env, url) {
  const db = env.DB;
  const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
  const category = (url.searchParams.get("category") || "").trim().slice(0, 60);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "60", 10) || 60));
  const where = [];
  const params = [];
  if (q) {
    where.push("name LIKE ?");
    params.push(`%${q.replace(/[%_]/g, "")}%`);
  }
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const t = await db.prepare(`SELECT COUNT(*) c FROM assets ${whereSql}`).bind(...params).first();
  const rows = await db
    .prepare(
      `SELECT key, name, category, content_type, size, created_at FROM assets ${whereSql} ORDER BY created_at DESC, key DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, perPage, (page - 1) * perPage)
    .all();
  const cats = await db.prepare("SELECT DISTINCT category FROM assets WHERE category != '' ORDER BY category").all();
  const base = req.url.split("/api/")[0];
  return json({
    success: true,
    total: t.c || 0,
    page,
    per_page: perPage,
    categories: (cats.results || []).map((r) => r.category),
    assets: (rows.results || []).map((r) => ({ ...r, url: `${base}/api/assets/${r.key}` })),
  });
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
      if (path.startsWith("/api/assets/") && req.method === "GET") {
        return await handleAsset(req, env, path.slice("/api/assets/".length));
      }

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

  /* writing studio */
  if (seg[2] === "documents") {
    return await handleDocuments(req, env, seg, url);
  }
  if (seg[2] === "folders") {
    return await handleFolders(req, env, seg);
  }
  if (seg[2] === "upload" && seg.length === 3 && req.method === "POST") {
    return await handleUpload(req, env);
  }
  if (seg[2] === "assets" && seg.length === 3 && req.method === "GET") {
    return await handleAssetsList(req, env, url);
  }

  return err("not_found", 404, "not_found");
}
