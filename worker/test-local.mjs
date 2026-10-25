/* Offline tests for the Worker: no deployment, no credentials, no network.
 * D1 is emulated on top of Node's built-in SQLite (node:sqlite, Node >= 22.5),
 * and the real migrations 0001-0004 are applied, so the SQL under test is the
 * SQL that runs in production (FTS5, triggers, partial unique index included).
 *
 * Run:  node --test test-local.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./src/worker.js";

/* ---------- minimal D1 emulation ---------- */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(new URL("./migrations/", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL("./migrations/" + f, import.meta.url), "utf8"));
  }
  const isRead = (sql) => /^\s*(select|with|pragma)/i.test(sql);
  const exec = (sql, params) => {
    const st = db.prepare(sql);
    if (isRead(sql)) return { results: st.all(...params), success: true, meta: {} };
    const r = st.run(...params);
    return { results: [], success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  };
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p; return stmt; },
      async first() { return exec(sql, params).results[0] ?? null; },
      async all() { return exec(sql, params); },
      async run() { return exec(sql, params); },
      _exec: () => exec(sql, params),
    };
    return stmt;
  };
  return {
    raw: db,
    prepare,
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const TOKEN = "a".repeat(64);
const DB = makeD1();
const env = { DB, ADMIN_TOKEN: TOKEN, SITE_ORIGIN: "https://adsrdsr2.github.io", EMAIL_PROVIDER: "none" };
const auth = { Authorization: `Bearer ${TOKEN}` };

async function api(path, { method = "GET", body, headers = {}, form, ip = "1.1.1.1" } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await worker.fetch(new Request("https://api.test" + path, init), env);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, res };
}
const A = (path, opts = {}) => api(path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
const png = (n) => { const u = new Uint8Array(n); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return u; };
const pngForm = (...sizes) => { const f = new FormData(); sizes.forEach((n, i) => f.append("file[]", new Blob([png(n)], { type: "image/png" }), `p${i}.png`)); return f; };
async function newDoc(over = {}) {
  const r = await A("/api/admin/documents", { method: "POST", body: { title: "t", document_type: "article", markdown_content: "hello", ...over } });
  assert.equal(r.status, 201);
  return r.data.document;
}
const day = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

/* ---------- auth ---------- */
test("auth: 401 without/with wrong token; only FAILED attempts are rate limited", async () => {
  assert.equal((await api("/api/admin/stats")).status, 401);
  let last;
  for (let i = 0; i < 31; i++) last = await api("/api/admin/stats", { headers: { Authorization: "Bearer nope" }, ip: "9.9.9.9" });
  assert.equal(last.status, 429, "brute force is throttled");
  // a neighbour on the same shared IP with the RIGHT token is never locked out
  assert.equal((await api("/api/admin/stats", { headers: auth, ip: "9.9.9.9" })).status, 200);
  // and heavy legitimate traffic is not throttled any more (old limit was 120/min)
  for (let i = 0; i < 130; i++) assert.equal((await A("/api/admin/health", { ip: "7.7.7.7" })).status, 200);
});

/* ---------- analytics ---------- */
test("analytics: zero-filled days, calendar windows, previous period, utm", async () => {
  const ins = (d, n, extra = {}) => {
    for (let i = 0; i < n; i++) {
      DB.raw.prepare("INSERT INTO analytics_events (event_id, session_id, visitor_id, path, device, utm_source, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(`ev-${d}-${i}-${Math.random()}`.padEnd(12, "x").slice(0, 60), `s${i}`, `v${i % 2}`, extra.path || "/a/", "mobile", extra.utm || null, `${d}T10:00:00Z`);
    }
  };
  ins(day(0), 3, { utm: "tg" });
  ins(day(-2), 2);
  ins(day(-6), 1);          // inside 7-day window (today-6 .. today)
  ins(day(-7), 4);          // exactly 7 days ago: OUTSIDE the 7-day window, inside the previous one
  const r = await A("/api/admin/analytics?days=7");
  const a = r.data.analytics;
  assert.equal(a.daily.length, 7, "every day present, even with zero traffic");
  assert.equal(a.daily[6].d, day(0));
  assert.equal(a.daily[6].views, 3);
  assert.equal(a.daily[5].views, 0);
  assert.equal(a.totals.views, 6);
  assert.equal(a.previous.views, 4, "previous period is the 7 days before");
  assert.equal(a.utm[0].source, "tg");
  const st = (await A("/api/admin/stats")).data.stats;
  assert.equal(st.views_today, 3);
  assert.equal(st.views_7d, 6, "7d window is exact (was off by a partial day)");
  assert.ok("docs_drafts" in st && "docs_sync_pending" in st);
});

/* ---------- documents ---------- */
test("documents: long Persian docs save (old 64 KB body limit), oversize -> 413", async () => {
  const d = await newDoc();
  const big = "سلام دنیا ".repeat(40000); // ~400k chars, ~700 KB UTF-8
  const r = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, markdown_content: big } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const huge = "سلام دنیا ".repeat(100000); // > 1.5 MB in UTF-8
  const r2 = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: r.data.version, markdown_content: huge } });
  assert.equal(r2.status, 413);
  // either guard may trip first (raw body size vs. content bytes); both are 413
  assert.ok(["content_too_large", "body_too_large"].includes(r2.data.error), r2.data.error);
  const r3 = await A(`/api/admin/documents/${d.id}`);
  assert.equal(r3.data.document.markdown_content.length, big.length, "nothing silently truncated");
});

test("documents: version conflict reports current_version", async () => {
  const d = await newDoc();
  await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, title: "x" } });
  const r = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, title: "y" } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "version_conflict");
  assert.equal(r.data.current_version, d.version + 1);
});

test("folders: a document can be moved OUT of a folder (folder_id: null)", async () => {
  const f = await A("/api/admin/folders", { method: "POST", body: { name: "F" } });
  const d = await newDoc({ folder_id: f.data.id });
  assert.equal(d.folder_id, f.data.id);
  const r = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, folder_id: null } });
  assert.equal(r.status, 200);
  assert.equal((await A(`/api/admin/documents/${d.id}`)).data.document.folder_id, null);
  const folders = (await A("/api/admin/folders")).data;
  assert.equal(folders.folders.find((x) => x.id === f.data.id).doc_count, 0);
  assert.ok(folders.totals.all >= 1 && "unfiled" in folders.totals);
});

test("publish rules: archive / trash / status-via-PUT refuse published docs", async () => {
  const d = await newDoc({ markdown_content: "body" });
  const pub = await A(`/api/admin/documents/${d.id}/publish`, { method: "POST", body: { slug: "rule-test", excerpt: "e" } });
  assert.equal(pub.status, 200);
  assert.equal((await A(`/api/admin/documents/${d.id}/archive`, { method: "POST" })).data.error, "must_unpublish_first");
  assert.equal((await A(`/api/admin/documents/${d.id}`, { method: "DELETE" })).data.error, "must_unpublish_first");
  const cur = (await A(`/api/admin/documents/${d.id}`)).data.document;
  const put = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: cur.version, status: "trashed" } });
  assert.equal(put.status, 409);
  await A(`/api/admin/documents/${d.id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await A(`/api/admin/documents/${d.id}/archive`, { method: "POST" })).status, 200);
});

test("restore from trash: slug collision is resolved instead of a 500", async () => {
  const a = await newDoc({ markdown_content: "x" });
  await A(`/api/admin/documents/${a.id}/publish`, { method: "POST", body: { slug: "clash-slug", excerpt: "e" } });
  await A(`/api/admin/documents/${a.id}/unpublish`, { method: "POST", body: {} });
  await A(`/api/admin/documents/${a.id}`, { method: "DELETE" });                       // trashed, keeps slug
  const b = await newDoc({ markdown_content: "y" });
  const pb = await A(`/api/admin/documents/${b.id}`, { method: "PUT", body: { version: b.version, slug: "clash-slug" } });
  assert.equal(pb.status, 200, "slug is free again while the first doc is trashed");
  const r = await A(`/api/admin/documents/${a.id}/restore`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug_cleared, true);
});

test("search: FTS works, and odd punctuation falls back to substring search", async () => {
  await newDoc({ title: "Quantum notes", markdown_content: "الگوریتم و ساختمان داده (فاز صفر)" });
  const ok = await A("/api/admin/documents?q=" + encodeURIComponent("الگوریتم"));
  assert.equal(ok.status, 200);
  assert.ok(ok.data.total >= 1);
  for (const q of ['"', "(", "فاز صفر)", "a*b", "%"]) {
    const r = await A("/api/admin/documents?q=" + encodeURIComponent(q));
    assert.equal(r.status, 200, `query ${JSON.stringify(q)} must not 400`);
  }
  const sub = await A("/api/admin/documents?q=" + encodeURIComponent("(فاز"));
  assert.ok(sub.data.total >= 1, "substring fallback finds it");
});

test("revisions: first edit keeps a baseline of the previous content", async () => {
  const d = await newDoc({ markdown_content: "ORIGINAL" });
  await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, markdown_content: "EDITED" } });
  const revs = (await A(`/api/admin/documents/${d.id}/revisions`)).data.revisions;
  assert.ok(revs.length >= 1);
  const full = (await A(`/api/admin/documents/${d.id}/revisions/${revs[revs.length - 1].id}`)).data.revision;
  assert.equal(full.markdown_content, "ORIGINAL");
});

test("duplicate gets a localised title", async () => {
  const d = await newDoc({ title: "Doc" });
  const r = await A(`/api/admin/documents/${d.id}/duplicate`, { method: "POST" });
  assert.equal((await A(`/api/admin/documents/${r.data.id}`)).data.document.title, "Doc (کپی)");
});

/* ---------- uploads / assets ---------- */
test("upload: 1.3 MB ok, 1.5 MB -> 413 (D1 2 MB row limit), batch is all-or-nothing", async () => {
  assert.equal((await A("/api/admin/upload", { method: "POST", form: pngForm(1_300_000) })).status, 200);
  assert.equal((await A("/api/admin/upload", { method: "POST", form: pngForm(1_500_000) })).status, 413);
  const before = DB.raw.prepare("SELECT COUNT(*) c FROM assets").get().c;
  const f = pngForm(1000, 1000);
  f.append("file[]", new Blob([new Uint8Array(500)], { type: "image/png" }), "bad.png"); // no magic bytes
  const r = await A("/api/admin/upload", { method: "POST", form: f });
  assert.equal(r.status, 400);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) c FROM assets").get().c, before, "no orphans left behind");
});

test("assets: list with usage, in-use delete refused, served with nosniff", async () => {
  const up = (await A("/api/admin/upload", { method: "POST", form: pngForm(2000) })).data.files[0];
  const used = await newDoc({ markdown_content: `![x](${up.url})` });
  const list = (await A("/api/admin/assets")).data;
  const row = list.assets.find((x) => x.key === up.key);
  assert.equal(row.used_in, 1);
  assert.equal((await A(`/api/admin/assets/${up.key}`, { method: "DELETE" })).data.error, "asset_in_use");
  const served = await api(`/api/assets/${up.key}`);
  assert.equal(served.status, 200);
  assert.equal(served.res.headers.get("x-content-type-options"), "nosniff");
  await A(`/api/admin/documents/${used.id}`, { method: "PUT", body: { version: used.version, markdown_content: "no image" } });
  assert.equal((await A(`/api/admin/assets/${up.key}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(`/api/assets/${up.key}`)).status, 404);
});

/* ---------- subscribers / csv ---------- */
test("csv export neutralises formula injection", async () => {
  DB.raw.prepare("INSERT INTO subscribers (email, email_norm, status, source, consent_at) VALUES (?,?,?,?,?)")
    .run("=1+1@example.com", "=1+1@example.com", "confirmed", '=HYPERLINK("http://evil")', new Date().toISOString());
  const r = await A("/api/admin/subscribers/export");
  assert.equal(r.status, 200);
  assert.ok(r.data.includes("'=1+1@example.com"), r.data);
  assert.ok(!/^=/m.test(r.data.replace("\uFEFF", "")), "no line/cell starts with =");
  assert.ok(r.data.includes(`"'=HYPERLINK(""http://evil"")"`));
});

/* ---------- campaigns ---------- */
test("campaigns: edit cannot blank title/subject; drafts deletable, sent ones not", async () => {
  const c = await A("/api/admin/campaigns", { method: "POST", body: { title: "T", subject: "S", body_html: "<p>x</p>" } });
  assert.equal(c.status, 201);
  assert.equal((await A(`/api/admin/campaigns/${c.data.id}`, { method: "PUT", body: { title: "", subject: "S" } })).status, 400);
  assert.equal((await A(`/api/admin/campaigns/${c.data.id}`, { method: "PUT", body: { title: "T2", subject: "S2" } })).status, 200);
  assert.equal((await A(`/api/admin/campaigns/${c.data.id}`, { method: "DELETE" })).status, 200);
  DB.raw.prepare("INSERT INTO campaigns (title, subject, status) VALUES ('s','s','sent')").run();
  const sent = DB.raw.prepare("SELECT id FROM campaigns WHERE status='sent'").get().id;
  assert.equal((await A(`/api/admin/campaigns/${sent}`, { method: "DELETE" })).status, 409);
});

/* ---------- misc admin ---------- */
test("health / audit / export", async () => {
  const h = (await A("/api/admin/health")).data.health;
  for (const t of ["documents", "folders", "revisions", "assets"]) assert.ok(t in h.tables, t);
  assert.ok("assets_bytes" in h.storage);
  const au = (await A("/api/admin/audit?limit=10")).data;
  assert.ok(Array.isArray(au.entries) && au.entries.length > 0);
  const ex = await A("/api/admin/export?revisions=1");
  assert.equal(ex.status, 200);
  assert.equal(ex.data.format, "ahura-backup-v1");
  assert.ok(ex.data.documents.length > 0 && Array.isArray(ex.data.revisions));
});

test("autosaves are not audited, manual saves are", async () => {
  const d = await newDoc();
  const count = () => DB.raw.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='document_update'").get().c;
  const c0 = count();
  const r = await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: d.version, title: "a" } });
  assert.equal(count(), c0);
  await A(`/api/admin/documents/${d.id}`, { method: "PUT", body: { version: r.data.version, title: "b", manual: true } });
  assert.equal(count(), c0 + 1);
});
