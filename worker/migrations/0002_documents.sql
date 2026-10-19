-- 0002_documents.sql: writing studio persistence.
-- Documents, folders, revision history, and binary asset storage.
-- R2 is not enabled on this account, so images are stored as BLOBs in D1
-- (suitable for this scale; migrate to R2 when the account enables it).

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  document_type TEXT NOT NULL DEFAULT 'note'
    CHECK (document_type IN ('note', 'article', 'docs', 'research', 'newsletter')),
  markdown_content TEXT NOT NULL DEFAULT '',
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'trashed')),
  is_pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);

-- Full-text search over title and content (external-content FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, markdown_content, content='documents', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, markdown_content)
  VALUES (new.id, new.title, new.markdown_content);
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, markdown_content)
  VALUES ('delete', old.id, old.title, old.markdown_content);
  INSERT INTO documents_fts(rowid, title, markdown_content)
  VALUES (new.id, new.title, new.markdown_content);
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, markdown_content)
  VALUES ('delete', old.id, old.title, old.markdown_content);
END;

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  markdown_content TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'auto' CHECK (reason IN ('manual', 'auto')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(document_id, id DESC);

CREATE TABLE IF NOT EXISTS assets (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
