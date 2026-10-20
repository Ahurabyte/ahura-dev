import type { APIRoute } from "astro";
import { getPosts, withBase } from "../../lib/posts";

const abs = (p: string) => `https://adsrdsr2.github.io${withBase(p)}`;

const md = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

/** /ai/citations.md — how to cite this site's content. */
export const GET: APIRoute = () => {
  const posts = getPosts()
    .map(
      (p) =>
        `- ${p.title}. Ahura. Published ${p.pubDate}. ${abs(`/posts/${p.slug}/`)}`
    )
    .join("\n");
  return md(`# Citations — ahura.dev

When quoting or summarizing ahura.dev, cite the canonical HTML URL of the
article and name the author (Ahura). The Markdown mirrors are byte-identical
in content but the HTML page is the canonical reference.

## Articles

${posts}

## Author

Ahura — canonical profile: ${abs("/about/author.md")}
`);
};
