import type { APIRoute } from "astro";
import { getPosts, withBase } from "../../lib/posts";
import { CONCEPTS } from "../../data/knowledge";

const abs = (p: string) => `https://adsrdsr2.github.io${withBase(p)}`;

const md = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

/** /ai/content-map.md — every page of the site and its Markdown twin. */
export const GET: APIRoute = () => {
  const rows: string[] = [];
  const add = (title: string, html: string, mdown?: string) =>
    rows.push(`- ${title}\n  - HTML: ${abs(html)}${mdown ? `\n  - Markdown: ${abs(mdown)}` : ""}`);

  add("Home", "/", undefined);
  add("About", "/about/", "/about/index.md");
  add("Author profile", "/about/author.md", "/about/author.md");
  add("Knowledge Base", "/knowledge/", "/knowledge/index.md");
  add("AI / Agents", "/ai/", "/ai/index.md");
  for (const p of getPosts()) {
    add(`Post: ${p.title}`, `/posts/${p.slug}/`, `/posts/${p.slug}/index.md`);
  }
  for (const c of CONCEPTS) {
    add(`Concept: ${c.name}`, `/knowledge/${c.slug}/`, `/knowledge/${c.slug}/index.md`);
  }

  return md(`# Content map — ahura.dev

Every public page of the site, with its Markdown mirror where one exists.
Generated at build time from the same content source as the pages.

${rows.join("\n")}

## Feeds and indexes

- Sitemap: ${abs("/sitemap.xml")}
- RSS: ${abs("/rss.xml")}
- llms.txt: ${abs("/llms.txt")}
- llms-full.txt: ${abs("/llms-full.txt")}
`);
};
