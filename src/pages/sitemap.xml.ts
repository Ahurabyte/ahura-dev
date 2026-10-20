import type { APIRoute } from "astro";
import { getPosts, withBase } from "../lib/posts";
import { CONCEPTS } from "../data/knowledge";

/**
 * sitemap.xml — generated at build time from the same content sources as the
 * pages themselves (posts + knowledge concepts + core pages). HTML pages only.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString() ?? "https://adsrdsr2.github.io/").replace(/\/$/, "");
  const u = (path: string) => `${origin}${withBase(path)}`;
  const today = new Date().toISOString().slice(0, 10);

  const core = ["/", "/about/", "/knowledge/", "/ai/"].map((p) => ({
    loc: u(p),
    lastmod: today,
  }));
  const posts = getPosts().map((p) => ({
    loc: u(`/posts/${p.slug}/`),
    lastmod: String(p.pubDate).slice(0, 10),
  }));
  const concepts = CONCEPTS.map((c) => ({ loc: u(`/knowledge/${c.slug}/`) }));

  const rows = [...core, ...posts, ...concepts]
    .map(
      (e) =>
        `  <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</urlset>
`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
