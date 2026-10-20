-- Migration 0004: publishing workflow for studio documents.
-- publish_state: 'draft' | 'published' — drafts and published posts are the
-- two dashboard sections. slug/excerpt are the blog metadata (URL + meta
-- description). published_at is set on first publish. sync_state tracks
-- whether the git copy (the MDX file in the repo) matches: 'dirty' means the
-- studio->git sync still has to process this document.
ALTER TABLE documents ADD COLUMN publish_state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE documents ADD COLUMN slug TEXT;
ALTER TABLE documents ADD COLUMN excerpt TEXT;
ALTER TABLE documents ADD COLUMN published_at TEXT;
ALTER TABLE documents ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'clean';
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug) WHERE slug IS NOT NULL AND status != 'trashed';
