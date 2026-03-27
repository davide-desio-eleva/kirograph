-- KiroGraph SQLite Schema

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL DEFAULT 0,
  end_column INTEGER NOT NULL DEFAULT 0,
  docstring TEXT,
  signature TEXT,
  visibility TEXT,
  is_exported INTEGER NOT NULL DEFAULT 0,
  is_async INTEGER NOT NULL DEFAULT 0,
  is_static INTEGER NOT NULL DEFAULT 0,
  is_abstract INTEGER NOT NULL DEFAULT 0,
  decorators TEXT,
  type_parameters TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  qualified_name,
  docstring,
  signature,
  content='nodes',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT,
  line INTEGER,
  column INTEGER
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  file_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_refs(source_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(ref_name);
