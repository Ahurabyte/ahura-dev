-- 0005_images.sql: cover images for documents + a named asset library.
-- documents.cover_image stores an assets.key (e.g. 'ab12...webp') chosen in
-- the studio; NULL means "no chosen cover" (site falls back to its local
-- card-<slug>.webp convention). assets gain name/category so the studio can
-- offer a searchable picker instead of anonymous upload keys.

ALTER TABLE documents ADD COLUMN cover_image TEXT;
ALTER TABLE assets ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN category TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
