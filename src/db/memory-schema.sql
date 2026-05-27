-- KiroGraph Memory Schema (opt-in, enableMemory=true)
-- Isolated from core graph tables. No FK to nodes(id) to avoid cascade on reindex.

CREATE TABLE IF NOT EXISTS mem_sessions (
  id TEXT PRIMARY KEY,
  ide TEXT,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mem_sessions_started ON mem_sessions(started_at);

CREATE TABLE IF NOT EXISTS mem_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES mem_sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  content_raw TEXT,
  content_hash TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'hook',
  tags TEXT,
  created_at INTEGER NOT NULL,
  valid_from INTEGER,
  valid_until INTEGER,
  superseded_by TEXT,
  fact_type TEXT DEFAULT 'observation'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_obs_hash ON mem_observations(content_hash);
CREATE INDEX IF NOT EXISTS idx_mem_obs_session ON mem_observations(session_id);
CREATE INDEX IF NOT EXISTS idx_mem_obs_kind ON mem_observations(kind);
CREATE INDEX IF NOT EXISTS idx_mem_obs_created ON mem_observations(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  id UNINDEXED,
  content,
  kind UNINDEXED
);

CREATE TABLE IF NOT EXISTS mem_links (
  observation_id TEXT NOT NULL REFERENCES mem_observations(id) ON DELETE CASCADE,
  qualified_name TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (observation_id, qualified_name)
);

CREATE INDEX IF NOT EXISTS idx_mem_links_qname ON mem_links(qualified_name);

CREATE TABLE IF NOT EXISTS mem_vectors (
  observation_id TEXT PRIMARY KEY REFERENCES mem_observations(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
