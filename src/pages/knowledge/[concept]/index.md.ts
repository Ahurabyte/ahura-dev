import type { APIRoute, GetStaticPaths } from "astro";
import { getPosts, withBase } from "../../../lib/posts";
import { CONCEPTS, conceptBySlug } from "../../../data/knowledge";

/** /knowledge/<concept>/index.md — Markdown mirror of a concept hub page. */
export const getStaticPaths: GetStaticPaths = () =>
  CONCEPTS.map((c) => ({ params: { concept: c.slug } }));

export const GET: APIRoute = ({ params }) => {
  const c = conceptBySlug(String(params.concept));
  if (!c) return new Response("Not found", { status: 404 });
  const abs = (p: string) => `https://ahurabyte.github.io${withBase(p)}`;
  const posts = getPosts().filter((p) => c.tag && p.tags.includes(c.tag!));
  const lines = [
    `# ${c.name}${c.nameFa ? ` — ${c.nameFa}` : ""}`,
    "",
    c.description,
    "",
    "## Related articles",
    "",
    ...(posts.length
      ? posts.map((p) => `- [${p.title}](${abs(`/posts/${p.slug}/`)}) — ${p.description}`)
      : ["No articles published under this topic yet."]),
    "",
    `- HTML version: ${abs(`/knowledge/${c.slug}/`)}`,
    `- Knowledge Base index: ${abs("/knowledge/")}`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
