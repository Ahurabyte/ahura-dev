import type { APIRoute } from "astro";
import { getPosts, withBase } from "../../lib/posts";
import { CONCEPTS } from "../../data/knowledge";

const abs = (p: string) => `https://adsrdsr2.github.io${withBase(p)}`;

const md = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

/** /ai/topics.md — topic map: each topic, its definition and where it is covered. */
export const GET: APIRoute = () => {
  const posts = getPosts();
  const lines = ["# Topics — ahura.dev", ""];
  let cat = "";
  for (const c of CONCEPTS) {
    if (c.category !== cat) {
      cat = c.category;
      lines.push(`## ${cat}`, "");
    }
    const rel = c.tag ? posts.filter((p) => p.tags.includes(c.tag!)) : [];
    lines.push(`### ${c.name}${c.nameFa ? ` (${c.nameFa})` : ""}`, "", c.description, "");
    lines.push(
      rel.length
        ? `Covered in: ${rel.map((p) => `[${p.title}](${abs(`/posts/${p.slug}/`)})`).join(", ")}`
        : "Covered in: no articles yet — this page is the standing definition.",
      ""
    );
  }
  return md(lines.join("\n"));
};
