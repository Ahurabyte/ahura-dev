export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  image: string;
}

const modules = import.meta.glob<{ frontmatter: Omit<PostMeta, 'slug' | 'image'> }>(
  '../content/posts/*.mdx',
  { eager: true },
);

export const withBase = (p: string) =>
  `${import.meta.env.BASE_URL}${p.replace(/^\//, '')}`;

const IMAGES: Record<string, string> = {
  'salam-donya': 'images/card-salam-donya.webp',
  'tech-stack': 'images/card-tech-stack.webp',
  'what-ill-write': 'images/card-what-ill-write.webp',
};

export const FALLBACK_IMAGE = 'images/card-about.webp';

export function getPosts(): PostMeta[] {
  return Object.entries(modules)
    .map(([path, mod]) => {
      const slug = path.split('/').pop()!.replace(/\.mdx$/, '');
      return {
        slug,
        ...mod.frontmatter,
        image: withBase(IMAGES[slug] ?? FALLBACK_IMAGE),
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
