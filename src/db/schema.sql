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

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

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
  updated_at INTEGER NOT NULL,
  -- Complexity metrics (nullable; populated when enableComplexity=true)
  complexity_cyclomatic INTEGER,
  complexity_cognitive INTEGER,
  complexity_halstead TEXT,
  maintainability_index REAL,
  nesting_depth INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
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
  column INTEGER,
  confidence TEXT NOT NULL DEFAULT 'extracted',
  confidence_score REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER,
  column INTEGER
);

CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_refs(source_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(ref_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_kind ON unresolved_refs(ref_kind);

-- Vectors table for future semantic search (opt-in)
CREATE TABLE IF NOT EXISTS vectors (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model);

-- ── Architecture tables (opt-in, only populated when enableArchitecture=true) ──

CREATE TABLE IF NOT EXISTS arch_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manifest','directory')),
  language TEXT,
  manifest_path TEXT,
  version TEXT,
  external_deps TEXT,  -- JSON array of strings
  metadata TEXT,       -- JSON object
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arch_packages_path ON arch_packages(path);
CREATE INDEX IF NOT EXISTS idx_arch_packages_source ON arch_packages(source);

CREATE TABLE IF NOT EXISTS arch_layers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('auto','config')),
  patterns TEXT NOT NULL,  -- JSON array of glob patterns
  metadata TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arch_file_packages (
  file_path TEXT NOT NULL,
  package_id TEXT NOT NULL REFERENCES arch_packages(id) ON DELETE CASCADE,
  PRIMARY KEY (file_path, package_id)
);

CREATE INDEX IF NOT EXISTS idx_arch_fp_file ON arch_file_packages(file_path);
CREATE INDEX IF NOT EXISTS idx_arch_fp_pkg ON arch_file_packages(package_id);

CREATE TABLE IF NOT EXISTS arch_file_layers (
  file_path TEXT NOT NULL,
  layer_id TEXT NOT NULL REFERENCES arch_layers(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  matched_pattern TEXT,
  PRIMARY KEY (file_path, layer_id)
);

CREATE INDEX IF NOT EXISTS idx_arch_fl_file ON arch_file_layers(file_path);
CREATE INDEX IF NOT EXISTS idx_arch_fl_layer ON arch_file_layers(layer_id);

CREATE TABLE IF NOT EXISTS arch_package_deps (
  source_pkg TEXT NOT NULL REFERENCES arch_packages(id) ON DELETE CASCADE,
  target_pkg TEXT NOT NULL REFERENCES arch_packages(id) ON DELETE CASCADE,
  dep_count INTEGER NOT NULL DEFAULT 1,
  files TEXT,  -- JSON array of {from,to} pairs (sample, max 5)
  PRIMARY KEY (source_pkg, target_pkg)
);

CREATE INDEX IF NOT EXISTS idx_arch_pkgdep_src ON arch_package_deps(source_pkg);
CREATE INDEX IF NOT EXISTS idx_arch_pkgdep_tgt ON arch_package_deps(target_pkg);

CREATE TABLE IF NOT EXISTS arch_layer_deps (
  source_layer TEXT NOT NULL REFERENCES arch_layers(id) ON DELETE CASCADE,
  target_layer TEXT NOT NULL REFERENCES arch_layers(id) ON DELETE CASCADE,
  dep_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source_layer, target_layer)
);

CREATE TABLE IF NOT EXISTS arch_coupling (
  package_id TEXT PRIMARY KEY REFERENCES arch_packages(id) ON DELETE CASCADE,
  afferent INTEGER NOT NULL DEFAULT 0,
  efferent INTEGER NOT NULL DEFAULT 0,
  instability REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL
);
