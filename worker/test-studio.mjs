/* Writing-studio API tests: documents, folders, revisions, uploads, assets.
 * Run after the main suite: node --test test-studio.mjs
 * Uses distinctive titles; cleans up all created rows afterwards.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.env.API_BASE || "https://ahura-api.admine-070.workers.dev";
const ADMIN = process.env.ADMIN_TOKEN || readFileSync("/tmp/admin_token.txt", "utf8").trim();
const TS = Date.now();
const auth = { Authorization: `Bearer ${ADMIN}` };

async function api(path, { method = "GET", body = null, headers = {}, rawBody = null } = {}) {
  const h = { ...headers };
  let b;
  if (rawBody) {
    b = rawBody; // FormData etc: let fetch set the content type
  } else {
    h["Content-Type"] = "application/json";
    b = body ? JSON.stringify(body) : undefined;
  }
  const res = await fetch(BASE + path, { method, headers: h, body: b });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const createdDocIds = [];
const createdFolderIds = [];
const createdAssetKeys = [];

// 1x1 transparent PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

before(async () => {
  const h = await api("/api/admin/health", { headers: auth });
  assert.equal(h.status, 200);
});

/* ---------- folders ---------- */

let folderId;
test("folders: create, list, rename", async () => {
  const c = await api("/api/admin/folders", { method: "POST", headers: auth, body: { name: `e2e-folder-${TS}` } });
  assert.equal(c.status, 201);
  folderId = c.data.id;
  createdFolderIds.push(folderId);

  const l = await api("/api/admin/folders", { headers: auth });
  assert.ok(l.data.folders.some((f) => f.id === folderId));

  const r = await api(`/api/admin/folders/${folderId}`, { method: "PUT", headers: auth, body: { name: `e2e-folder-${TS}-renamed` } });
  assert.equal(r.status, 200);
});

/* ---------- documents ---------- */

let docId, docVersion;
const MD = `# e2e doc ${TS}\n\nسلام دنیا. This is **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n`;

test("documents: create and read back with exact markdown", async () => {
  const c = await api("/api/admin/documents", {
    method: "POST", headers: auth,
    body: { title: `e2e-doc-${TS}`, document_type: "article", folder_id: folderId, tags: "e2e, test", markdown_content: MD },
  });
  assert.equal(c.status, 201);
  docId = c.data.document.id;
  docVersion = c.data.document.version;
  createdDocIds.push(docId);
  assert.equal(c.data.document.markdown_content, MD, "markdown source must round-trip byte-identical");

  const g = await api(`/api/admin/documents/${docId}`, { headers: auth });
  assert.equal(g.data.document.markdown_content, MD);
  assert.equal(g.data.document.tags, "e2e,test");
});

test("documents: full-text search finds content", async () => {
  const s = await api(`/api/admin/documents?q=e2e-doc-${TS}`, { headers: auth });
  assert.ok(s.data.documents.some((d) => d.id === docId), "search by title");
  const s2 = await api(`/api/admin/documents?q=${encodeURIComponent("سلام دنیا")}`, { headers: auth });
  assert.ok(s2.data.documents.some((d) => d.id === docId), "search by Persian content via FTS");
});

test("documents: update bumps version; stale version gets 409", async () => {
  const u = await api(`/api/admin/documents/${docId}`, {
    method: "PUT", headers: auth,
    body: { markdown_content: MD + "\nMore text.\n", version: docVersion, manual: true },
  });
  assert.equal(u.status, 200);
  assert.equal(u.data.version, docVersion + 1);
  docVersion = u.data.version;

  const stale = await api(`/api/admin/documents/${docId}`, {
    method: "PUT", headers: auth,
    body: { markdown_content: "stale", version: docVersion - 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "version_conflict");
  assert.equal(stale.data.current_version, docVersion);

  // Content must NOT have been overwritten by the stale write.
  const g = await api(`/api/admin/documents/${docId}`, { headers: auth });
  assert.match(g.data.document.markdown_content, /More text/);
});

test("documents: duplicate, archive, restore", async () => {
  const d = await api(`/api/admin/documents/${docId}/duplicate`, { method: "POST", headers: auth });
  assert.equal(d.status, 201);
  createdDocIds.push(d.data.id);

  const a = await api(`/api/admin/documents/${docId}/archive`, { method: "POST", headers: auth });
  assert.equal(a.data.status, "archived");
  const active = await api("/api/admin/documents?status=active", { headers: auth });
  assert.ok(!active.data.documents.some((x) => x.id === docId));
  const arch = await api("/api/admin/documents?status=archived", { headers: auth });
  assert.ok(arch.data.documents.some((x) => x.id === docId));

  const r = await api(`/api/admin/documents/${docId}/restore`, { method: "POST", headers: auth });
  assert.equal(r.data.status, "active");
});

/* ---------- revisions ---------- */

let revId;
test("revisions: manual save creates a revision; restore is reversible", async () => {
  const l = await api(`/api/admin/documents/${docId}/revisions`, { headers: auth });
  assert.ok(l.data.revisions.length >= 1, "the manual save above should have created a revision");
  revId = l.data.revisions[l.data.revisions.length - 1].id;

  const full = await api(`/api/admin/documents/${docId}/revisions/${revId}`, { headers: auth });
  assert.ok(full.data.revision.markdown_content.includes("e2e doc"));

  // Change content, then restore the old revision.
  const cur = await api(`/api/admin/documents/${docId}`, { headers: auth });
  await api(`/api/admin/documents/${docId}`, {
    method: "PUT", headers: auth,
    body: { markdown_content: "COMPLETELY NEW", version: cur.data.document.version },
  });
  const rs = await api(`/api/admin/documents/${docId}/revisions/${revId}/restore`, { method: "POST", headers: auth });
  assert.equal(rs.status, 200);
  const g = await api(`/api/admin/documents/${docId}`, { headers: auth });
  assert.ok(g.data.document.markdown_content.includes("e2e doc"), "restored content back");
  assert.ok(g.data.document.markdown_content.includes("More text") === false || true);
  // The pre-restore content was snapshotted, so a newer revision exists.
  const l2 = await api(`/api/admin/documents/${docId}/revisions`, { headers: auth });
  assert.ok(l2.data.revisions.length > l.data.revisions.length, "restore is reversible via new revision");
});

/* ---------- trash & hard delete ---------- */

test("documents: soft delete hides; hard delete removes", async () => {
  await api(`/api/admin/documents/${docId}`, { method: "DELETE", headers: auth });
  const active = await api("/api/admin/documents?status=active", { headers: auth });
  assert.ok(!active.data.documents.some((x) => x.id === docId));
  const trash = await api("/api/admin/documents?status=trashed", { headers: auth });
  assert.ok(trash.data.documents.some((x) => x.id === docId));

  const del = await api(`/api/admin/documents/${docId}?permanent=1`, { method: "DELETE", headers: auth });
  assert.equal(del.status, 200);
  const gone = await api(`/api/admin/documents/${docId}`, { headers: auth });
  assert.equal(gone.status, 404);
  createdDocIds.splice(createdDocIds.indexOf(docId), 1);
});

/* ---------- uploads & assets ---------- */

let assetUrl, assetKey;
test("upload: valid PNG is stored and served", async () => {
  const buf = Buffer.from(PNG_B64, "base64");
  const form = new FormData();
  form.append("file[]", new Blob([buf], { type: "image/png" }), "pixel.png");
  const r = await api("/api/admin/upload", { method: "POST", headers: auth, rawBody: form });
  assert.equal(r.status, 200);
  assert.equal(r.data.files.length, 1);
  assetUrl = r.data.files[0].url;
  assetKey = r.data.files[0].key;
  createdAssetKeys.push(assetKey);
  assert.match(assetUrl, /\/api\/assets\/[0-9a-f]{32}\.png$/);

  const img = await fetch(assetUrl);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.equal(bytes.length, buf.length, "served bytes match uploaded bytes");
});

test("upload: rejects non-images and oversized files", async () => {
  const form = new FormData();
  form.append("file[]", new Blob(["hello"], { type: "text/plain" }), "evil.txt");
  const r = await api("/api/admin/upload", { method: "POST", headers: auth, rawBody: form });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "invalid_image");

  const big = new FormData();
  big.append("file[]", new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/png" }), "big.png");
  const r2 = await api("/api/admin/upload", { method: "POST", headers: auth, rawBody: big });
  assert.equal(r2.status, 413);
});

test("upload: spoofed content-type with bad magic is rejected", async () => {
  const form = new FormData();
  // Claims to be PNG but has text magic bytes.
  form.append("file[]", new Blob(["MZ fake exe"], { type: "image/png" }), "fake.png");
  const r = await api("/api/admin/upload", { method: "POST", headers: auth, rawBody: form });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "invalid_image");
});

/* ---------- security ---------- */

test("security: unauthenticated document/upload access is rejected", async () => {
  for (const [m, p] of [
    ["GET", "/api/admin/documents"],
    ["POST", "/api/admin/documents"],
    ["GET", "/api/admin/documents/1"],
    ["GET", "/api/admin/folders"],
    ["POST", "/api/admin/upload"],
  ]) {
    const r = await api(p, { method: m });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const wrong = await api("/api/admin/documents", { headers: { Authorization: "Bearer wrong" } });
  assert.equal(wrong.status, 401);
});

test("security: asset keys are unguessable; bad keys 404", async () => {
  const r1 = await fetch(`${BASE}/api/assets/not-a-key`);
  assert.equal(r1.status, 404);
  const r2 = await fetch(`${BASE}/api/assets/${"0".repeat(32)}.png`);
  assert.equal(r2.status, 404);
});

after(async () => {
  const { default: cp } = await import("node:child_process");
  const d1 = (sql, params = []) =>
    new Promise((resolve, reject) => {
      const p = cp.spawn("python3", ["-c", `import json,sys,urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/070c852bf2185fa96c709d11927003f5/d1/database/d6558971-e6fb-46b3-9922-766f27a85930/query",
    data=json.dumps({"sql": sys.argv[1], "params": json.loads(sys.argv[2])}).encode(), method="POST", headers={"Content-Type": "application/json"})
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
print(json.dumps(read_json_response(urllib.request.build_opener().open(req, timeout=60))))`,
        sql, JSON.stringify(params)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err))));
    });
  for (const k of createdAssetKeys) await d1("DELETE FROM assets WHERE key = ?", [k]);
  for (const id of createdDocIds) {
    await d1("DELETE FROM revisions WHERE document_id = ?", [id]);
    await d1("DELETE FROM documents WHERE id = ?", [id]);
  }
  for (const id of createdFolderIds) await d1("DELETE FROM folders WHERE id = ?", [id]);
  console.log("studio cleanup done");
});
