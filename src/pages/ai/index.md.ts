import type { APIRoute } from "astro";
import { getPosts, withBase } from "../../lib/posts";
import { CONCEPTS } from "../../data/knowledge";

const abs = (p: string) => `https://adsrdsr2.github.io${withBase(p)}`;

const md = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

/** /ai/index.md — Markdown mirror of the /ai/ landing page. */
export const GET: APIRoute = () =>
  md(`# AI / Agents — ahura.dev

This section is the machine-readable complement of ahura.dev. It never
replaces the human-readable HTML; both are generated from one content source.

## Entry points

- [llms.txt](${abs("/llms.txt")}) — condensed index of the whole site
- [llms-full.txt](${abs("/llms-full.txt")}) — full text of every post, one file
- [content-map.md](${abs("/ai/content-map.md")}) — every URL and its Markdown twin
- [topics.md](${abs("/ai/topics.md")}) — topic map with definitions
- [Author profile](${abs("/about/author.md")})
- [RSS](${abs("/rss.xml")}) · [Sitemap](${abs("/sitemap.xml")})

## Citation rule

Each article has one canonical URL (the HTML version). The Markdown mirror
carries identical content, author and date; cite the HTML URL.
`);
