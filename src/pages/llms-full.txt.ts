import type { APIRoute } from "astro";
import { getPosts } from "../lib/posts";
import { postMarkdown, AUTHOR_MD } from "../lib/markdownContent";
import { CONCEPTS } from "../data/knowledge";

/**
 * /llms-full.txt — the entire site's long-form content in one Markdown file:
 * author profile, knowledge-base definitions, then every post in full.
 */
export const GET: APIRoute = () => {
  const parts: string[] = [
    "# ahura.dev — full content",
    "",
    "This file aggregates all long-form content of ahura.dev in Markdown.",
    "Source of truth remains the HTML site; this file is generated from it",
    "at build time, never edited by hand.",
    "",
    "---",
    "",
    AUTHOR_MD,
    "",
    "---",
    "",
    "# Knowledge base",
    "",
  ];
  for (const c of CONCEPTS) {
    parts.push(`## ${c.name}`, "", c.description, "");
  }
  parts.push("---", "", "# Blog posts (full text)", "");
  for (const p of getPosts()) {
    const md = postMarkdown(p.slug);
    if (md) parts.push(md, "", "---", "");
  }
  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
