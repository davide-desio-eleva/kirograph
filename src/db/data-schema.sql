-- KiroGraph Data Schema (opt-in, enableData=true)
-- Tabular data indexing with column profiling and row storage.

CREATE TABLE IF NOT EXISTS data_datasets (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  format        TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  column_count  INTEGER NOT NULL,
  file_size     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  summary       TEXT,
  indexed_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_datasets_file ON data_datasets(file_path);
CREATE INDEX IF NOT EXISTS idx_data_datasets_hash ON data_datasets(content_hash);

CREATE TABLE IF NOT EXISTS data_columns (
  id            TEXT PRIMARY KEY,
  dataset_id    TEXT NOT NULL REFERENCES data_datasets(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL,
  inferred_type TEXT NOT NULL,
  nullable      INTEGER NOT NULL DEFAULT 0,
  null_count    INTEGER NOT NULL DEFAULT 0,
  null_pct      REAL NOT NULL DEFAULT 0.0,
  cardinality   INTEGER NOT NULL DEFAULT 0,
  min_value     TEXT,
  max_value     TEXT,
  mean_value    REAL,
  sample_values TEXT,
  summary       TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_columns_dataset ON data_columns(dataset_id);

-- Cross-references: data files ↔ code symbols
CREATE TABLE IF NOT EXISTS data_code_refs (
  dataset_id      TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (dataset_id, qualified_name, ref_type)
);

CREATE INDEX IF NOT EXISTS idx_data_code_refs_qname ON data_code_refs(qualified_name);
CREATE INDEX IF NOT EXISTS idx_data_code_refs_dataset ON data_code_refs(dataset_id);

-- Schema history for drift detection
CREATE TABLE IF NOT EXISTS data_dataset_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  column_count INTEGER NOT NULL,
  columns_json TEXT NOT NULL,  -- JSON array of {name, type, cardinality, nullPct}
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_history_dataset ON data_dataset_history(dataset_id, snapshot_at DESC);
