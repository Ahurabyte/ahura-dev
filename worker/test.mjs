/* End-to-end tests for the deployed ahura-api Worker.
 * Run: ADMIN_TOKEN=$(cat /tmp/admin_token.txt) node --test test.mjs
 * Uses distinctive /__test__/ paths and test+ addresses; cleans up afterwards.
 * Every assertion below runs against the real deployment, nothing is mocked.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const BASE = process.env.API_BASE || "https://ahura-api.admine-070.workers.dev";
const ADMIN = process.env.ADMIN_TOKEN || readFileSync("/tmp/admin_token.txt", "utf8").trim();
const TS = Date.now();
const auth = { Authorization: `Bearer ${ADMIN}` };

async function api(path, { method = "GET", body = null, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, data, raw: res };
}

async function d1(sql, params = []) {
  // Direct D1 access for test setup/teardown only (not part of the Worker API).
  const { default: cp } = await import("node:child_process");
  const payload = JSON.stringify({ sql, params });
  return new Promise((resolve, reject) => {
    const p = cp.spawn("python3", [
      "-c",
      `import json,sys,urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/070c852bf2185fa96c709d11927003f5/d1/database/d6558971-e6fb-46b3-9922-766f27a85930/query",
    data=sys.stdin.read().encode(), method="POST", headers={"Content-Type": "application/json"})
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
print(json.dumps(read_json_response(urllib.request.build_opener().open(req, timeout=60))))`,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    p.stdin.write(payload);
    p.stdin.end();
  });
}

const testEmail = `test+${TS}@example.com`;
let subscriberId = null;

before(async () => {
  const h = await api("/api/admin/health", { headers: auth });
  assert.equal(h.status, 200, "worker must be reachable with admin token");
});

/* ---------- analytics ---------- */

test("analytics: valid page-view is ingested", async () => {
  const r = await api("/api/analytics", {
    method: "POST",
    body: { event_id: randomUUID(), session_id: randomUUID(), path: "/__test__/page", device: "desktop" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
});

test("analytics: duplicate event_id is deduplicated, not double-counted", async () => {
  const eid = randomUUID();
  const body = { event_id: eid, session_id: randomUUID(), path: "/__test__/dedupe", device: "mobile" };
  const before = await d1("SELECT COUNT(*) c FROM analytics_events WHERE path = '/__test__/dedupe'");
  const n0 = before.result[0].results[0].c;
  await api("/api/analytics", { method: "POST", body });
  const r2 = await api("/api/analytics", { method: "POST", body });
  assert.equal(r2.data.deduplicated, true);
  const after = await d1("SELECT COUNT(*) c FROM analytics_events WHERE path = '/__test__/dedupe'");
  assert.equal(after.result[0].results[0].c, n0 + 1);
});

test("analytics: invalid events are rejected", async () => {
  const r = await api("/api/analytics", { method: "POST", body: { event_id: "bad", session_id: randomUUID(), path: "/" } });
  assert.equal(r.status, 400);
});

test("analytics: stats reflect ingested events", async () => {
  const r = await api("/api/admin/stats", { headers: auth });
  assert.ok(r.data.stats.views_today >= 2, "test page-views should be counted");
});

/* ---------- newsletter ---------- */

test("subscribe: invalid email is rejected", async () => {
  const r = await api("/api/subscribe", { method: "POST", body: { email: "not-an-email" } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "invalid_email");
});

test("subscribe: valid email becomes pending (no provider -> email_sent=false)", async () => {
  const r = await api("/api/subscribe", { method: "POST", body: { email: testEmail, source: "e2e" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "pending_confirmation");
  assert.equal(r.data.email_sent, false, "must not claim an email was sent");
  assert.equal(r.data.provider, "none");
  const s = await d1("SELECT id, status FROM subscribers WHERE email_norm = ?", [testEmail.toLowerCase()]);
  subscriberId = s.result[0].results[0].id;
  assert.equal(s.result[0].results[0].status, "pending_confirmation");
});

test("subscribe: duplicate pending signup is idempotent", async () => {
  const r = await api("/api/subscribe", { method: "POST", body: { email: testEmail } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "pending_confirmation");
});

test("confirm: bad token is rejected", async () => {
  const res = await fetch(`${BASE}/api/confirm?token=deadbeef`);
  const text = await res.text();
  assert.match(text, /Invalid or expired/);
});

test("confirm: valid token activates the subscription", async () => {
  const raw = `e2e-confirm-${TS}-`.padEnd(40, "0");
  const hash = createHash("sha256").update(raw).digest("hex");
  const exp = new Date(Date.now() + 3600e3).toISOString();
  await d1("INSERT INTO email_tokens (subscriber_id, token_hash, purpose, expires_at) VALUES (?, ?, 'confirm', ?)", [subscriberId, hash, exp]);
  const res = await fetch(`${BASE}/api/confirm?token=${raw}`);
  const text = await res.text();
  assert.match(text, /Subscription confirmed/);
  const s = await d1("SELECT status FROM subscribers WHERE id = ?", [subscriberId]);
  assert.equal(s.result[0].results[0].status, "confirmed");
});

test("subscribe: confirmed address reports already_subscribed", async () => {
  const r = await api("/api/subscribe", { method: "POST", body: { email: testEmail } });
  assert.equal(r.data.status, "already_subscribed");
});

test("unsubscribe: token link unsubscribes without login", async () => {
  const raw = `e2e-unsub-${TS}-`.padEnd(40, "0");
  const hash = createHash("sha256").update(raw).digest("hex");
  const exp = new Date(Date.now() + 3600e3).toISOString();
  await d1("INSERT INTO email_tokens (subscriber_id, token_hash, purpose, expires_at) VALUES (?, ?, 'unsubscribe', ?)", [subscriberId, hash, exp]);
  const res = await fetch(`${BASE}/api/unsubscribe?token=${raw}`);
  assert.match(await res.text(), /Unsubscribed/);
  const s = await d1("SELECT status FROM subscribers WHERE id = ?", [subscriberId]);
  assert.equal(s.result[0].results[0].status, "unsubscribed");
});

test("subscribe: resubscribing after unsubscribe is blocked (409)", async () => {
  await d1("DELETE FROM rate_limits"); // isolate from the per-email rate limit of earlier steps
  const r = await api("/api/subscribe", { method: "POST", body: { email: testEmail } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "previously_unsubscribed");
});

/* ---------- admin auth & subscribers ---------- */

test("admin: anonymous requests are rejected", async () => {
  for (const p of ["/api/admin/stats", "/api/admin/subscribers", "/api/admin/campaigns", "/api/admin/subscribers/export"]) {
    const r = await api(p);
    assert.equal(r.status, 401, p);
  }
});

test("admin: wrong token is rejected", async () => {
  const r = await api("/api/admin/stats", { headers: { Authorization: "Bearer wrong-token" } });
  assert.equal(r.status, 401);
});

test("admin: subscriber search finds the test subscriber", async () => {
  const r = await api(`/api/admin/subscribers?q=test%2B${TS}`, { headers: auth });
  assert.equal(r.status, 200);
  assert.ok(r.data.subscribers.some((s) => s.email === testEmail));
});

test("admin: CSV export requires auth and returns CSV", async () => {
  const anon = await api("/api/admin/subscribers/export");
  assert.equal(anon.status, 401);
  const res = await fetch(`${BASE}/api/admin/subscribers/export`, { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(await res.text(), /email,status,source/);
});

/* ---------- campaigns ---------- */

let campaignId = null;
test("campaigns: draft can be created", async () => {
  const r = await api("/api/admin/campaigns", {
    method: "POST", headers: auth,
    body: { title: `e2e ${TS}`, subject: "test", body_html: "<p>hi</p>", body_text: "hi" },
  });
  assert.equal(r.status, 201);
  campaignId = r.data.id;
});

test("campaigns: send is refused without a mail provider (honest 409)", async () => {
  const r = await api(`/api/admin/campaigns/${campaignId}/send`, { method: "POST", headers: auth });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "email_provider_not_configured");
});

after(async () => {
  // Cleanup: remove test data so production stays clean.
  if (subscriberId) await d1("DELETE FROM email_tokens WHERE subscriber_id = ?", [subscriberId]);
  if (subscriberId) await d1("DELETE FROM subscribers WHERE id = ?", [subscriberId]);
  if (campaignId) await d1("DELETE FROM campaigns WHERE id = ?", [campaignId]);
  await d1("DELETE FROM analytics_events WHERE path LIKE '/__test__%'");
  console.log("cleanup done");
});
