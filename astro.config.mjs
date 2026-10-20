// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

const base = '/ahura-dev/';

/**
 * Rewrites root-relative image URLs inside Markdown/MDX post bodies
 * (e.g. `![](/images/foo.webp)`) so they respect the site's base path.
 * External URLs are left untouched.
 */
function rehypePrefixImages() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.tagName === 'img') {
        const src = node.properties && node.properties.src;
        if (typeof src === 'string' && src.startsWith('/') && !src.startsWith(base)) {
          node.properties.src = base + src.slice(1);
        }
        // Machine- and performance-friendly body images (point 15 of the
        // agent-readability brief): decode off the main thread, load lazily.
        node.properties = node.properties || {};
        if (!node.properties.loading) node.properties.loading = 'lazy';
        if (!node.properties.decoding) node.properties.decoding = 'async';
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

// https://astro.build/config
// The domain the site is actually served from TODAY. Canonical URLs, Open
// Graph, sitemap and RSS all derive from this. When the ahura.dev custom
// domain is connected, flip this back to 'https://ahura.dev'.
export default defineConfig({
  site: 'https://ahurabyte.github.io',
  base,
  markdown: {
    rehypePlugins: [rehypePrefixImages],
  },
  integrations: [mdx(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
