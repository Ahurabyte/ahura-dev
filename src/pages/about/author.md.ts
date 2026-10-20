import type { APIRoute } from "astro";
import { AUTHOR_MD } from "../../lib/markdownContent";

/** /about/author.md — the canonical machine-readable author profile. */
export const GET: APIRoute = () =>
  new Response(AUTHOR_MD, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
