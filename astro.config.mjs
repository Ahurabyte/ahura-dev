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
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

// https://astro.build/config
export default defineConfig({
  site: 'https://ahura.dev',
  base,
  markdown: {
    rehypePlugins: [rehypePrefixImages],
  },
  integrations: [mdx(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
