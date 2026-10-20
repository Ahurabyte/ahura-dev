import type { APIRoute } from "astro";

/**
 * /about/index.md — Markdown mirror of the About page, kept in sync with the
 * visible page's own text (the author's words, verbatim).
 */
export const GET: APIRoute = () =>
  new Response(
    `# درباره من

## عاشق تکنولوژی

سلام! من اهورام. وقتی دارم یه چیز جدید یاد می‌گیرم یا یه ابزار باحال پیدا می‌کنم، دوست دارم بنویسمش که هم خودم یادم بمونه، هم شاید به درد تو هم خورد.

---

- HTML version: https://adsrdsr2.github.io/ahura-dev/about/
- Machine-readable author profile: https://adsrdsr2.github.io/ahura-dev/about/author.md
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } }
  );
