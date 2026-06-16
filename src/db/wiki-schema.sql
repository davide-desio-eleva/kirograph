-- KiroGraph Wiki Schema (opt-in, enableWiki=true)
-- Isolated from core graph tables. Source of truth is .kirograph/wiki/*.md files.
-- This is a fast-search index; regeneratable via `kirograph wiki reindex`.

CREATE TABLE IF NOT EXISTS wiki_pages (
  slug        TEXT PRIMARY KEY,   -- e.g. "AuthService", "arch/auth-model"
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,      -- full markdown content
  file_path   TEXT,               -- relative path under .kirograph/wiki/ (null if not yet written)
  updated_at  INTEGER NOT NULL,   -- epoch ms of last ingest
  source_count INTEGER DEFAULT 0  -- number of sources that contributed to this page
);

-- Standalone FTS5 table (stores its own copy of indexed content)
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts
  USING fts5(slug, title, content, tokenize='porter ascii');

-- Keep FTS in sync (insert)
CREATE TRIGGER IF NOT EXISTS wiki_fts_insert AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, slug, title, content) VALUES (new.rowid, new.slug, new.title, new.content);
END;

-- Keep FTS in sync (update: delete old FTS entry then insert new)
CREATE TRIGGER IF NOT EXISTS wiki_fts_update AFTER UPDATE ON wiki_pages BEGIN
  DELETE FROM wiki_fts WHERE rowid = old.rowid;
  INSERT INTO wiki_fts(rowid, slug, title, content) VALUES (new.rowid, new.slug, new.title, new.content);
END;

-- Keep FTS in sync (delete)
CREATE TRIGGER IF NOT EXISTS wiki_fts_delete AFTER DELETE ON wiki_pages BEGIN
  DELETE FROM wiki_fts WHERE rowid = old.rowid;
END;

-- Pending sources for local-model synthesis (wikiSynthesisMode: 'local')
CREATE TABLE IF NOT EXISTS wiki_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  source_text TEXT NOT NULL,
  queued_at   INTEGER NOT NULL
);
