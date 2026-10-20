import type { APIRoute, GetStaticPaths } from "astro";
import { getPosts } from "../../../lib/posts";
import { postMarkdown } from "../../../lib/markdownContent";

/**
 * Markdown mirror of every post: /posts/<slug>/index.md
 * Generated from the same MDX source as the HTML page — they cannot drift.
 */
export const getStaticPaths: GetStaticPaths = () =>
  getPosts().map((p) => ({ params: { slug: p.slug } }));

export const GET: APIRoute = ({ params }) => {
  const md = postMarkdown(String(params.slug));
  if (!md) return new Response("Not found", { status: 404 });
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
