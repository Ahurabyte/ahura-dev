import { getPosts, withBase } from "./posts";

/**
 * Shared builders for the machine-readable layer: llms.txt, the per-post
 * Markdown mirrors and the /ai/ section. Everything derives from the same
 * content source (the MDX files), so HTML, Markdown, RSS, sitemap and
 * llms.txt can never drift apart.
 */

const raws = import.meta.glob<string>("../content/posts/*.mdx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Raw MDX body of a post with the YAML frontmatter removed. */
export function postBody(slug: string): string {
  const key = Object.keys(raws).find((k) => k.endsWith(`/${slug}.mdx`));
  if (!key) return "";
  return raws[key].replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/** Full standalone Markdown document for one post. */
export function postMarkdown(slug: string): string | null {
  const post = getPosts().find((p) => p.slug === slug);
  if (!post) return null;
  const lines = [
    `# ${post.title}`,
    "",
    `> ${post.description}`,
    "",
    `- Published: ${new Date(post.pubDate).toISOString().slice(0, 10)}`,
    `- Author: Ahura`,
    `- Canonical: https://ahurabyte.github.io${withBase(`/posts/${slug}/`)}`,
    post.tags.length ? `- Tags: ${post.tags.join(", ")}` : "",
    "",
    "---",
    "",
    postBody(slug),
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export const AUTHOR_MD = `# Ahura — Author Profile

Ahura is a software developer and technology writer. He writes a Persian
personal blog at ahura.dev about what he is learning and building.

## Topics

- Artificial Intelligence (AI agents, MCP, AI-assisted development)
- Open Source software and open-source tooling
- Software Engineering and Web Development (Astro, TypeScript)
- Digital Health and AI in Nursing (research interests)

## Projects

- ahura.dev — personal blog (Astro, GitHub Pages, Cloudflare Workers/D1 backend)
- A Persian-language algorithms course (four levels, beginner to upper-beginner)
- AI agent experiments hosted on free infrastructure with Telegram delivery

## Articles

Published posts are listed in the content map:
https://ahurabyte.github.io/ahura-dev/ai/content-map.md

## Identity

- Name: Ahura
- Site: https://ahurabyte.github.io/ahura-dev/
- Languages of the site: Persian (fa) with English technical terms
- This file is the canonical machine-readable author profile.
`;
