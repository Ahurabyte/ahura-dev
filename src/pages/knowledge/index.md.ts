import type { APIRoute } from "astro";
import { getPosts, withBase } from "../../lib/posts";
import { CONCEPTS } from "../../data/knowledge";

/** /knowledge/index.md — Markdown mirror of the Knowledge Base index. */
export const GET: APIRoute = () => {
  const abs = (p: string) => `https://ahurabyte.github.io${withBase(p)}`;
  const posts = getPosts();
  const lines = ["# Knowledge Base — ahura.dev", ""];
  let cat = "";
  for (const c of CONCEPTS) {
    if (c.category !== cat) {
      cat = c.category;
      lines.push(`## ${cat}`, "");
    }
    const n = c.tag ? posts.filter((p) => p.tags.includes(c.tag!)).length : 0;
    lines.push(
      `### [${c.name}](${abs(`/knowledge/${c.slug}/`)})${c.nameFa ? ` — ${c.nameFa}` : ""}`,
      "",
      c.description,
      "",
      n > 0 ? `Related articles: ${n}` : "Related articles: none published yet.",
      "",
    );
  }
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
