#!/usr/bin/env node
/* sync-blog.mjs — push published writing-studio documents to the blog repo.
 *
 * Reads documents flagged sync_state='dirty' from D1:
 *   - published + active  -> write src/content/posts/<slug>.mdx
 *   - anything else       -> remove that MDX file (unpublished/trashed)
 * Then commits + pushes the posts directory if anything changed, and marks
 * the processed rows clean. Run by Muse on request (no cron by design).
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = join(ROOT, "src", "content", "posts");

function d1(sql, params = []) {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import json,sys,urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/070c852bf2185fa96c709d11927003f5/d1/database/d6558971-e6fb-46b3-9922-766f27a85930/query",
    data=json.dumps({"sql": sys.argv[1], "params": json.loads(sys.argv[2])}).encode(), method="POST", headers={"Content-Type": "application/json"})
add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
print(json.dumps(read_json_response(urllib.request.build_opener().open(req, timeout=60))))`,
      sql,
      JSON.stringify(params),
    ],
    { encoding: "utf8" }
  );
  const res = JSON.parse(p.stdout);
  if (!res.success) throw new Error("D1 error: " + JSON.stringify(res.errors));
  return res.result[0];
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function mdxFor(doc) {
  const tags = (doc.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const fm = [
    "---",
    `title: ${JSON.stringify(doc.title)}`,
    `description: ${JSON.stringify(doc.excerpt || "")}`,
    `pubDate: ${doc.published_at}`,
    tags.length ? `tags: [${tags.join(", ")}]` : "tags: []",
    "---",
    "",
  ].join("\n");
  return fm + (doc.markdown_content || "").trim() + "\n";
}

const rows = d1(
  "SELECT id, title, excerpt, published_at, tags, markdown_content, publish_state, slug, status FROM documents WHERE sync_state = 'dirty'"
).results;

if (!rows.length) {
  console.log("sync: nothing dirty — blog is in sync with the studio.");
  process.exit(0);
}

const done = [];
const changed = [];
for (const doc of rows) {
  if (!doc.slug) {
    done.push(doc.id);
    continue;
  }
  const file = join(POSTS_DIR, `${doc.slug}.mdx`);
  if (doc.publish_state === "published" && doc.status === "active") {
    writeFileSync(file, mdxFor(doc), "utf8");
    changed.push(`write ${doc.slug}.mdx`);
  } else if (existsSync(file)) {
    unlinkSync(file);
    changed.push(`remove ${doc.slug}.mdx`);
  }
  done.push(doc.id);
}

const dirty = git(["status", "--porcelain", "--", "src/content/posts"]);
if (dirty) {
  git(["add", "-A", "src/content/posts"]);
  git([
    "-c", "user.name=Ahura", "-c", "user.email=ahura@users.noreply.github.com",
    "commit", "-q", "-m", "Sync posts from writing studio",
  ]);
  git(["push", "-q"]);
  console.log("sync: pushed to GitHub:", changed.join(", ") || "(file contents unchanged)");
} else {
  console.log("sync: no file changes needed:", changed.join(", ") || "—");
}
for (const id of done) d1("UPDATE documents SET sync_state = 'clean' WHERE id = ?", [id]);
console.log(`sync: ${done.length} document(s) marked clean`);
