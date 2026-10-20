import type { APIRoute } from "astro";
import { getPosts, withBase } from "../lib/posts";

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** rss.xml — generated at build time from the posts collection. */
export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString() ?? "https://ahurabyte.github.io/").replace(/\/$/, "");
  const home = `${origin}${withBase("/")}`;
  const items = getPosts()
    .map((p) => {
      const link = `${origin}${withBase(`/posts/${p.slug}/`)}`;
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${new Date(p.pubDate).toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ahura.dev — وبلاگ اهورا</title>
    <link>${home}</link>
    <atom:link href="${home}rss.xml" rel="self" type="application/rss+xml" />
    <description>وبلاگ شخصی اهورا — یادداشت‌ها، تجربه‌ها و چیزهایی که یاد می‌گیرم.</description>
    <language>fa-IR</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
