export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  tags: string[];
  image: string;
}

const modules = import.meta.glob<{
  frontmatter: Omit<PostMeta, 'slug' | 'image' | 'tags'> & { tags?: string[] };
}>('../content/posts/*.mdx', { eager: true });

export const withBase = (p: string) =>
  `${import.meta.env.BASE_URL}${p.replace(/^\//, '')}`;

export const FALLBACK_IMAGE = 'images/card-about.webp';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Cover image for a post: the `card-<slug>.webp` convention (checked on
 *  disk at build time; `process.cwd()` is the project root during
 *  `astro build`), then the generic fallback. */
function imageFor(slug: string): string {
  const candidates = [`images/card-${slug}.webp`, FALLBACK_IMAGE];
  for (const rel of candidates) {
    try {
      if (existsSync(join(process.cwd(), 'public', rel))) return withBase(rel);
    } catch {
      /* fall through to the next candidate */
    }
  }
  return withBase(FALLBACK_IMAGE);
}

export function getPosts(): PostMeta[] {
  return Object.entries(modules)
    .map(([path, mod]) => {
      const slug = path.split('/').pop()!.replace(/\.mdx$/, '');
      const { tags, ...rest } = mod.frontmatter;
      return {
        slug,
        ...rest,
        tags: Array.isArray(tags) ? tags : [],
        image: imageFor(slug),
      };
    })
    .sort((a, b) => new Date(b.pubDate).valueOf() - new Date(a.pubDate).valueOf());
}

export const faDate = (d: string) =>
  new Intl.DateTimeFormat('fa-IR', { dateStyle: 'long' }).format(new Date(d));

/** Absolute URL (origin from astro.config `site`) for a base-prefixed path —
 *  what Open Graph / JSON-LD / sitemap consumers expect. */
export function absoluteUrl(basePath: string): string {
  const origin = (import.meta.env.SITE || 'https://adsrdsr2.github.io').replace(/\/$/, '');
  return `${origin}${basePath.startsWith('/') ? '' : '/'}${basePath}`;
}

import { readFileSync } from 'node:fs';

/** Pixel dimensions of a WebP in `public/` (VP8/VP8L/VP8X), read at build
 *  time for <img width/height> and ImageObject JSON-LD. Null when unknown. */
export function webpDims(relPublicPath: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(join(process.cwd(), 'public', relPublicPath));
    if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const CATEGORIES = [
  'ایجنت‌های هوش مصنوعی',
  'یادگیری برنامه‌نویسی',
  'ابزارهای متن‌باز',
  'حرف‌های متفرقه',
];
