import type { APIRoute } from "astro";
import { getPosts, withBase } from "../lib/posts";
import { CONCEPTS } from "../data/knowledge";

/**
 * /llms.txt — the agent-facing index of this site (llmstxt.org convention).
 * Generated at build time from the same content as the HTML site.
 */
export const GET: APIRoute = () => {
  const abs = (p: string) => `https://adsrdsr2.github.io${withBase(p)}`;
  const posts = getPosts()
    .map(
      (p) =>
        `- [${p.title}](${abs(`/posts/${p.slug}/`)}): ${p.description} (Markdown: ${abs(`/posts/${p.slug}/index.md`)})`
    )
    .join("\n");
  const concepts = CONCEPTS.map(
    (c) => `- [${c.name}](${abs(`/knowledge/${c.slug}/`)}): ${c.description.split(".")[0]}.`
  ).join("\n");

  const body = `# ahura.dev — Ahura's personal blog

> Personal blog of Ahura, a software developer and technology writer.
> Content is in Persian (fa) with English technical terminology.
> Every page also exists as a Markdown mirror for agents.

## Blog posts

${posts}

## Knowledge base

${concepts}

## Machine-readable entry points

- [Full text of all posts](${abs("/llms-full.txt")}): every article in one file
- [AI section index](${abs("/ai/")}): the machine-readable layer of this site
- [Content map](${abs("/ai/content-map.md")}): every URL and its Markdown twin
- [Topics](${abs("/ai/topics.md")}): topic map with definitions
- [Author profile](${abs("/about/author.md")}): canonical author information
- [Sitemap](${abs("/sitemap.xml")})
- [RSS feed](${abs("/rss.xml")})

## Author

Ahura — software developer and technology writer.
Canonical author profile: ${abs("/about/author.md")}
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
