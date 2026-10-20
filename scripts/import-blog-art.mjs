#!/usr/bin/env node
/* import-blog-art.mjs — import the blog-art collections into the studio
 * image library (Worker assets, D1) so covers/in-body images can be picked
 * from the dashboard. Goes through the production upload endpoint so the
 * storage path is identical to a manual studio upload. Idempotent: files
 * whose (name, category) already exist in the library are skipped.
 *
 * Sources:
 *   ~/workspace/your_files/blog-art/    -> category «مجموعه ۱»
 *   ~/workspace/your_files/blog-art-2/  -> category «مجموعه ۲»
 *   public/images/ (this repo)          -> category «کاورهای فعلی»
 * Admin token is read from /tmp/admin_token.txt (never committed).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const API = "https://ahura-api.admine-070.workers.dev";
const TOKEN = readFileSync("/tmp/admin_token.txt", "utf8").trim();

const SOURCES = [
  { dir: join(homedir(), "workspace/your_files/blog-art"), category: "مجموعه ۱" },
  { dir: join(homedir(), "workspace/your_files/blog-art-2"), category: "مجموعه ۲" },
  { dir: new URL("../public/images", import.meta.url).pathname, category: "کاورهای فعلی" },
];

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: "Bearer " + TOKEN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

const existing = new Set();
{
  let page = 1;
  for (;;) {
    const r = await api(`/api/admin/assets?per_page=100&page=${page}`);
    for (const a of r.assets) existing.add(`${a.category}::${a.name}`);
    if (page * r.per_page >= r.total) break;
    page++;
  }
}
console.log(`library currently holds ${existing.size} image(s)`);

let uploaded = 0;
let skipped = 0;
for (const { dir, category } of SOURCES) {
  const files = readdirSync(dir).filter((f) => /\.webp$/i.test(f)).sort();
  for (const f of files) {
    const name = basename(f).replace(/\.webp$/i, "");
    if (existing.has(`${category}::${name}`)) {
      skipped++;
      continue;
    }
    const buf = readFileSync(join(dir, f));
    const form = new FormData();
    form.append("file[]", new Blob([buf], { type: "image/webp" }), f);
    form.append("asset_name", name);
    form.append("asset_category", category);
    const r = await api("/api/admin/upload", { method: "POST", body: form });
    uploaded++;
    console.log(`+ [${category}] ${name} -> ${r.files[0].key}`);
  }
}
const final = await api("/api/admin/assets?per_page=1");
console.log(`done: uploaded=${uploaded} skipped=${skipped} library_total=${final.total}`);
