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

/** Cover image for a post: the `card-<slug>.webp` convention (checked on
 *  disk at build time), then the generic fallback. */
function imageFor(slug: string): string {
  const candidates = [`images/card-${slug}.webp`, FALLBACK_IMAGE];
  for (const rel of candidates) {
    try {
      if (existsSync(new URL(`../../public/${rel}`, import.meta.url)))
        return withBase(rel);
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

export const CATEGORIES = [
  'ایجنت‌های هوش مصنوعی',
  'یادگیری برنامه‌نویسی',
  'ابزارهای متن‌باز',
  'حرف‌های متفرقه',
];
