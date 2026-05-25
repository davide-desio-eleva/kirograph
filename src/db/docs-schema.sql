-- KiroGraph Documentation Schema (opt-in, enableDocs=true)
-- Isolated from core graph tables. Uses qualified_name for code refs (stable across reindex).

CREATE TABLE IF NOT EXISTS doc_sections (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  title         TEXT NOT NULL,
  level         INTEGER NOT NULL,
  parent_id     TEXT,
  summary       TEXT,
  byte_start    INTEGER NOT NULL,
  byte_end      INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  tags          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_sections_file ON doc_sections(file_path);
CREATE INDEX IF NOT EXISTS idx_doc_sections_parent ON doc_sections(parent_id);
CREATE INDEX IF NOT EXISTS idx_doc_sections_hash ON doc_sections(content_hash);

-- FTS5 index for section search
CREATE VIRTUAL TABLE IF NOT EXISTS doc_sections_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  content='doc_sections',
  content_rowid='rowid'
);

-- Cross-references between doc sections and code symbols
CREATE TABLE IF NOT EXISTS doc_code_refs (
  section_id      TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (section_id, qualified_name, ref_type)
);

CREATE INDEX IF NOT EXISTS idx_doc_code_refs_qname ON doc_code_refs(qualified_name);
CREATE INDEX IF NOT EXISTS idx_doc_code_refs_section ON doc_code_refs(section_id);

-- Vectors for doc section embeddings (uses same semantic engine as code)
CREATE TABLE IF NOT EXISTS doc_vectors (
  section_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
