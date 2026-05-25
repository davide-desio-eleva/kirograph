# Data Module — Implementation Plan

## Overview

A new `src/data/` module that brings structured tabular data navigation into kirograph's knowledge graph. Inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/), but implemented natively in TypeScript and fully integrated with kirograph's existing architecture: same DB, same MCP tool surface, same installer flow.

The core idea: index tabular data files (CSV, TSV, JSON, JSONL, Excel, Parquet) **once**, profile their columns (types, cardinality, nulls, distributions, samples), store rows in SQLite, then let agents query with structured filters and server-side aggregations instead of loading entire files into context.

---

## Design Principles

1. **Same patterns as existing modules** — follows the `enableDocs` / `enableMemory` / `enableArchitecture` precedent: config flag, installer toggle, conditional tool registration, gated CLI commands.
2. **Column as the unit of orientation** — agents understand a dataset by its schema (column profiles), not by reading raw rows.
3. **Server-side computation** — filters, aggregations, and joins run in SQLite. Only results enter the context window.
4. **Code-aware** — unlike standalone data tools, kirograph can link data files to code that reads/writes them (via import paths, file references in code).
5. **Optional dependencies for extended formats** — CSV/TSV/JSONL/JSON parsing is built-in (zero deps). Excel (.xlsx) and Parquet require optional packages (`xlsx`, `parquetjs-lite`).
6. **Strictly local-first** — no GitHub API, no remote fetching. Only indexes data files present on disk.
7. **Separate from code search** — data tools are their own `kirograph_data_*` prefix, not mixed into code tools.
8. **Token budget enforcement** — hard caps on rows returned, response token limits, anti-loop detection.
9. **Streaming parser** — never loads full file into memory. Processes line-by-line (CSV/JSONL) or in chunks (Excel/Parquet).

---

## What Data Is Considered

### jDataMunch scope

jDataMunch indexes **any tabular data** — local files or remote GitHub repos. It supports:
- CSV / TSV (built-in)
- Excel (.xlsx, .xls) — optional dep
- Parquet (.parquet) — optional dep
- JSONL / NDJSON (.jsonl, .ndjson) — built-in

It treats data as a standalone concern, disconnected from code.

### Kirograph data module scope

We focus on **project-local data files that live alongside code** — test fixtures, seed data, configuration tables, sample datasets, and data files referenced by the codebase.

| Category | Examples | Included |
|----------|----------|----------|
| Test fixtures | `tests/fixtures/users.csv`, `test-data/orders.json` | ✅ |
| Seed/migration data | `seeds/products.csv`, `db/seeds/categories.jsonl` | ✅ |
| Configuration tables | `config/feature-flags.csv`, `data/mappings.tsv` | ✅ |
| Sample datasets | `data/sample.csv`, `examples/demo-data.jsonl` | ✅ |
| Excel spreadsheets | `data/report.xlsx`, `tests/fixtures/inventory.xlsx` | ✅ (requires `xlsx` optional dep) |
| Parquet files | `data/events.parquet`, `analytics/metrics.parquet` | ✅ (requires `parquetjs-lite` optional dep) |
| Large production data | Multi-GB files | ❌ (excluded by `dataMaxFileSize`, default 50MB) |
| Binary data | Images, videos, archives | ❌ (not tabular) |
| Database dumps | `.sql` files | ❌ (not tabular — these are code) |
| Node modules data | `node_modules/**/*.csv` | ❌ (excluded by default) |

### Supported formats

| Format | Extensions | Dependencies | Parsing strategy |
|--------|-----------|-------------|-----------------|
| **CSV** | `.csv` | None (built-in) | Line-by-line streaming |
| **TSV** | `.tsv` | None (built-in) | Line-by-line streaming (tab delimiter) |
| **JSONL / NDJSON** | `.jsonl`, `.ndjson` | None (built-in) | Line-by-line streaming |
| **JSON array** | `.json` (in `data/` dirs) | None (built-in) | Streaming array parse |
| **Excel** | `.xlsx`, `.xls` | `xlsx` (optional) | Sheet-by-sheet, row iteration |
| **Parquet** | `.parquet` | `parquetjs-lite` (optional) | Column-chunk streaming |

Excel and Parquet are **optional** — if the packages aren't installed, those files are silently skipped during indexing. The installer offers to install them when `enableData` is toggled on.

**Key difference from jDataMunch:** we don't index remote repos or arbitrary datasets. We index the data files that ship with the project. The value proposition is the **code ↔ data cross-reference** — knowing that `src/importers/product-loader.ts` reads `data/products.csv` and understanding the schema without loading the file.

### Default include/exclude patterns

```
dataInclude: [
  '**/*.csv',
  '**/*.tsv',
  '**/*.jsonl',
  '**/*.ndjson',
  '**/*.xlsx',
  '**/*.xls',
  '**/*.parquet',
  'data/**/*.json'
]

dataExclude: [
  'node_modules/**',
  'dist/**',
  'build/**',
  '.git/**',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/tsconfig.json',
  '**/jsconfig.json',
  'coverage/**',
  '**/generated/**'
]
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     WRITE PATH (indexing)                         │
│                                                                  │
│  kirograph data index ──→ scan dataInclude/dataExclude           │
│                       ──→ detect format (CSV/TSV/JSONL/JSON)     │
│                       ──→ streaming parse (never loads full file) │
│                       ──→ column profiling (types, cardinality,  │
│                            nulls, min/max, samples, distribution)│
│                       ──→ write rows to data_rows (SQLite)       │
│                       ──→ write profiles to data_columns         │
│                       ──→ generate summaries (first-sentence)    │
│                       ──→ content hash for incremental detection │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     READ PATH (MCP + CLI)                         │
│                                                                  │
│  kirograph_data_describe  ──→ data_columns (schema + profiles)  │
│  kirograph_data_query     ──→ parameterized SQL on data_rows    │
│  kirograph_data_aggregate ──→ GROUP BY SQL on data_rows         │
│  kirograph_data_search    ──→ column name/value search           │
│  kirograph_data_list      ──→ list all indexed datasets          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Module Structure

```
src/data/
├── types.ts              # DataSet, DataColumn, DataRow, QueryFilter, AggregateOp
├── indexer.ts            # DataIndexer — scan, parse, profile, persist
├── profiler.ts           # Column profiling (type inference, stats, distributions)
├── queries.ts            # Read helpers for MCP tools (describe, query, aggregate)
├── parsers/
│   ├── index.ts          # Format registry + dispatcher
│   ├── csv.ts            # CSV/TSV streaming parser (built-in)
│   ├── jsonl.ts          # JSONL/NDJSON streaming parser (built-in)
│   ├── json-array.ts     # JSON array files (built-in)
│   ├── excel.ts          # Excel .xlsx/.xls parser (requires optional `xlsx` dep)
│   └── parquet.ts        # Parquet parser (requires optional `parquetjs-lite` dep)
├── filters.ts            # Structured filter → SQL WHERE clause builder
└── lint.ts               # dataLint() — integrity checks
```

---

## Data Model

### New DB tables (applied when `enableData: true`)

```sql
-- Indexed datasets
CREATE TABLE IF NOT EXISTS data_datasets (
  id            TEXT PRIMARY KEY,   -- dataset name (derived from file path)
  file_path     TEXT NOT NULL,      -- relative path to data file
  format        TEXT NOT NULL,      -- 'csv' | 'tsv' | 'jsonl' | 'json' | 'xlsx' | 'parquet'
  row_count     INTEGER NOT NULL,
  column_count  INTEGER NOT NULL,
  file_size     INTEGER NOT NULL,   -- bytes
  content_hash  TEXT NOT NULL,      -- SHA-256 for incremental detection
  summary       TEXT,               -- auto-generated NL summary
  indexed_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_datasets_file ON data_datasets(file_path);

-- Column profiles
CREATE TABLE IF NOT EXISTS data_columns (
  id            TEXT PRIMARY KEY,   -- {dataset}::{column_name}#column
  dataset_id    TEXT NOT NULL REFERENCES data_datasets(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL,   -- column order (0-based)
  inferred_type TEXT NOT NULL,      -- 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'null'
  nullable      INTEGER NOT NULL DEFAULT 0,
  null_count    INTEGER NOT NULL DEFAULT 0,
  null_pct      REAL NOT NULL DEFAULT 0.0,
  cardinality   INTEGER NOT NULL DEFAULT 0,
  min_value     TEXT,
  max_value     TEXT,
  mean_value    REAL,
  sample_values TEXT,               -- JSON array of up to 5 sample values
  summary       TEXT,               -- NL description of the column
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_columns_dataset ON data_columns(dataset_id);

-- Row data (stored in SQLite for querying)
-- Each dataset gets its own table: data_rows_{dataset_id}
-- Created dynamically during indexing with columns matching the source file.
-- This avoids a single wide EAV table and enables proper SQL queries.

-- Cross-references: data files ↔ code symbols
CREATE TABLE IF NOT EXISTS data_code_refs (
  dataset_id      TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,      -- code symbol that references this data file
  ref_type        TEXT NOT NULL,      -- 'reads' | 'writes' | 'imports' | 'configures'
  confidence      REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (dataset_id, qualified_name, ref_type)
);

CREATE INDEX IF NOT EXISTS idx_data_code_refs_qname ON data_code_refs(qualified_name);
```

---

## Configuration

New fields in `KiroGraphConfig`:

```typescript
/** Enable tabular data indexing and querying. Default: false. */
enableData: boolean;

/** Glob patterns for data files to include. */
dataInclude: string[];
// default: ['**/*.csv', '**/*.tsv', '**/*.jsonl', '**/*.ndjson', 'data/**/*.json']

/** Glob patterns for data files to exclude. */
dataExclude: string[];
// default: ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/package-lock.json',
//           '**/yarn.lock', '**/pnpm-lock.yaml', 'coverage/**', '**/generated/**']

/** Enable auto-linking of data files to code symbols. Default: true (when enableData is true). */
dataLinkCode: boolean;

/**
 * Max datasets to include in kirograph_context results.
 * 0 = disabled (data never appears in kirograph_context, agent must use kirograph_data_* tools explicitly).
 * When > 0, only datasets referenced by the symbols found are included.
 * Asked during install only when enableData is true.
 * Default: 0 (disabled — opt-in via installer).
 */
dataContextLimit: number;

/** Max file size for data files (bytes). Default: 50MB (52_428_800). */
dataMaxFileSize: number;

/** Max rows to index per file. Default: 1,000,000. */
dataMaxRows: number;

/** Max rows returned per query. Default: 500. */
dataQueryLimit: number;

/** Max token budget per response. Default: 8000. */
dataMaxResponseTokens: number;
```

Added to `KNOWN_FIELDS` set and `validateConfig()`.

**Optional dependencies for extended formats:**

When the user enables Excel or Parquet support during install, the installer runs:
```bash
npm install xlsx              # for .xlsx/.xls support
npm install parquetjs-lite    # for .parquet support
```

Same pattern as semantic engine deps (`better-sqlite3`, `@orama/orama`, etc.) — if the package isn't installed, the parser silently skips those files. No crash, no error — just a note in `kirograph data lint` that some files were skipped.

---

## MCP Tools

Eight dedicated tools, following the `kirograph_docs_*` / `kirograph_mem_*` naming pattern:

| Tool | Description | Args |
|------|-------------|------|
| `kirograph_data_list` | List all indexed datasets with row counts, column counts, file sizes | `{ projectPath?: string }` |
| `kirograph_data_describe` | Full schema profile: column names, types, cardinality, null%, samples, summary | `{ dataset: string, column?: string }` |
| `kirograph_data_query` | Filtered row retrieval with structured operators (eq, gt, contains, in, between, etc.) | `{ dataset: string, filters?: Filter[], columns?: string[], limit?: number, offset?: number }` |
| `kirograph_data_aggregate` | Server-side GROUP BY: count, sum, avg, min, max, count_distinct | `{ dataset: string, groupBy: string[], metrics: Metric[], filters?: Filter[] }` |
| `kirograph_data_search` | Search column names and sample values by keyword or semantically | `{ dataset: string, query: string, semantic?: boolean }` |
| `kirograph_data_join` | SQL JOIN across two indexed datasets (inner, left, right) | `{ left: string, right: string, on: JoinCondition, type?: string, columns?: string[], filters?: Filter[], limit?: number }` |
| `kirograph_data_correlations` | Pairwise Pearson correlations between numeric columns | `{ dataset: string, threshold?: number }` |
| `kirograph_data_quality` | Data quality triage: rank columns by risk (null rate, cardinality anomalies, outliers) | `{ dataset: string }` |

All tools gated behind `enableData: true`.

### Filter operators

```typescript
interface QueryFilter {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'is_null' | 'between';
  value: any;
}
```

Multiple filters are ANDed. All queries use parameterized SQL — zero injection surface.

### Aggregate metrics

```typescript
interface AggregateMetric {
  column: string;
  op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
}
```

### Join conditions

```typescript
interface JoinCondition {
  leftColumn: string;
  rightColumn: string;
}
```

Join types: `inner` (default), `left`, `right`. Both datasets must be indexed. Uses SQLite `ATTACH DATABASE` pattern (same as jDataMunch). Column projection and per-side filters supported.

### Correlation output

```typescript
interface CorrelationPair {
  column1: string;
  column2: string;
  correlation: number;  // -1.0 to 1.0
  strength: 'strong' | 'moderate' | 'weak' | 'negligible';
}
```

---

## Installer Integration

### Opt-in behavior

The data module is **optional and off by default**, exactly like `enableDocs`, `enableMemory`, and `enableArchitecture`. It is:
- **Not enabled** unless the user explicitly toggles it during `kirograph install`
- **Not enabled** on existing projects unless the user manually sets `"enableData": true` in `.kirograph/config.json`
- **Gated at every entry point**: MCP tools return a helpful error, CLI commands exit with a message, the sync pipeline skips data indexing — all when `enableData` is `false`

This ensures zero overhead for users who don't need data querying.

### Config prompt (`src/bin/installer/config-prompt.ts`)

New section after "Documentation", before "Agent Behavior":

```
📊 Data

  Tabular data indexing:
  Indexes CSV/TSV/JSONL files for structured querying.
  Enables kirograph_data_list, kirograph_data_describe, kirograph_data_query,
  kirograph_data_aggregate, kirograph_data_search.
```

Toggle: `enableData` (default: `false`)

**If `enableData` is toggled on**, two follow-up prompts appear:

```
  Install optional format support?
  Excel (.xlsx) requires the 'xlsx' package. Parquet requires 'parquetjs-lite'.
  CSV, TSV, JSONL, and JSON are always supported (no extra deps).

  ● Excel support (xlsx):     yes / no
  ● Parquet support:          yes / no
```

Then:

```
  Include dataset schemas in kirograph_context results?
  When enabled, relevant dataset schemas are automatically surfaced alongside
  code symbols in kirograph_context. Set to 0 to keep data separate (use
  kirograph_data_* tools explicitly).

  Max datasets in context (0 = disabled): [0]
```

Arrow-key select or numeric input. Default: `0` (disabled). Suggested values: `0`, `2`, `5`.

### ConfigPatch type

Add `enableData` and `dataContextLimit` to the `ConfigPatch` type.

### Installer late phase (`installLate`)

Pass `enableData` to `writeHooks` and `writeSteering` so:
- Steering file mentions data tools when enabled
- No additional hooks needed (data re-indexes on `kirograph sync` like code and docs)
- MCP `autoApprove` list includes `kirograph_data_*` tools when enabled

### CLI command (`src/bin/commands/data.ts`)

```
kirograph data list                         — list indexed datasets
kirograph data describe <dataset>           — show schema + column profiles
kirograph data describe <dataset> --column <name>  — deep dive on one column
kirograph data query <dataset> [--filter ...]      — filtered row retrieval
kirograph data aggregate <dataset> [--group-by ...] [--metric ...]  — server-side aggregation
kirograph data search <dataset> <query>     — search columns by keyword
kirograph data index                        — index all data files
kirograph data reindex                      — force re-index
kirograph data lint                         — validate index integrity
```

All commands check `enableData` and exit with:
```
  ✖ Data indexing is not enabled. Set enableData: true in .kirograph/config.json
  Then re-run: kirograph index
```

---

## Integration with Existing Features

### `kirograph_context`

When building context for a code symbol, optionally query `data_code_refs` and include relevant dataset schemas. **This is opt-in and disabled by default** (`dataContextLimit: 0`).

Behavior:
- `dataContextLimit: 0` (default) → `kirograph_context` never includes data schemas. The agent uses `kirograph_data_*` tools explicitly when it needs data exploration.
- `dataContextLimit: N` (user-configured via installer) → `kirograph_context` includes up to N dataset schemas that are referenced by the symbols found. Each dataset is shown as column names + types (compact).

This avoids flooding context with schema information the agent didn't ask for.

### Sync Pipeline

`IndexPipeline` gains a data indexing step after docs indexing (when `enableData: true`). Only re-indexes files whose content hash changed. Respects `dataMaxFileSize` and `dataMaxRows` limits.

### Token Savings (kirograph_gain)

New `'data'` source category in `TokenSavingsRecord.source`. Naive cost heuristics added to `src/compression/naive-cost.ts`:

| Tool | Naive cost | Typical output | Savings |
|------|-----------|----------------|---------|
| `kirograph_data_describe` | ~50,000–111M tokens (full file read) | ~2,000–4,000 tokens | **96–99.99%** |
| `kirograph_data_query` | ~50,000+ tokens (full file) | ~1,000–3,000 tokens | **94–99%** |
| `kirograph_data_aggregate` | ~50,000+ tokens (full file + LLM aggregation) | ~500–1,500 tokens | **97–99%** |
| `kirograph_data_search` | ~10,000 tokens (scan headers + grep) | ~200–500 tokens | **95–98%** |
| `kirograph_data_list` | ~2,000 tokens (ls + file inspection) | ~200–400 tokens | **80–90%** |

### Architecture Layer

Data files are auto-assigned to a `data` layer when architecture analysis is enabled.

### Memory

Data exploration patterns can be captured as memory observations when `enableMemory` is active.

### `kirograph_status`

When `enableData: true`, `kirograph_status` shows data stats: datasets indexed, total rows, total columns, file size.

---

## Implementation Phases

### Phase 1 — Core (MVP)

- [ ] `src/data/types.ts` — interfaces
- [ ] `src/data/parsers/csv.ts` — streaming CSV/TSV parser
- [ ] `src/data/parsers/jsonl.ts` — JSONL/NDJSON parser
- [ ] `src/data/parsers/json-array.ts` — JSON array parser
- [ ] `src/data/parsers/excel.ts` — Excel .xlsx/.xls parser (optional dep: `xlsx`)
- [ ] `src/data/parsers/parquet.ts` — Parquet parser (optional dep: `parquetjs-lite`)
- [ ] `src/data/parsers/index.ts` — format registry (graceful skip when optional deps missing)
- [ ] `src/data/profiler.ts` — column profiling (type inference, stats)
- [ ] `src/data/indexer.ts` — orchestrator (scan → parse → profile → persist)
- [ ] `src/data/filters.ts` — structured filter → SQL WHERE builder
- [ ] `src/data/queries.ts` — read helpers
- [ ] `src/db/data-schema.sql` — schema
- [ ] `GraphDatabase.applyDataSchema()` method
- [ ] Config: `enableData`, `dataInclude`, `dataExclude`, `dataLinkCode`, `dataContextLimit`, `dataMaxFileSize`, `dataMaxRows`, `dataQueryLimit`, `dataMaxResponseTokens`
- [ ] MCP tools: `kirograph_data_list`, `kirograph_data_describe`, `kirograph_data_query`, `kirograph_data_aggregate`
- [ ] Naive cost heuristics in `naive-cost.ts` for all 8 data tools
- [ ] Token tracker: new `'data'` source category in `TokenSavingsRecord.source`
- [ ] Installer toggle in `config-prompt.ts` (opt-in, default `false`) + optional deps install + `dataContextLimit` follow-up
- [ ] `ConfigPatch` type updated with `enableData` and `dataContextLimit`
- [ ] `installLate` signature extended with `enableData` parameter
- [ ] MCP `autoApprove` list updated with 8 new `kirograph_data_*` tools
- [ ] `KIROGRAPH_TOOL_NAMES` array updated in `src/mcp/tool-names.ts`
- [ ] CLI: `kirograph data {list,describe,query,aggregate,index,reindex}`
- [ ] Sync pipeline integration (incremental re-index on `kirograph sync`)
- [ ] Steering file updated: mentions data tools when `enableData` is enabled
- [ ] Build script: copy `data-schema.sql` to dist
- [ ] `kirograph_status` enhanced: shows data stats when enabled
- [ ] **README.md** updated:
  - New "Data indexing (opt-in)" section under "How Indexing Works"
  - 8 new MCP tool entries in the "MCP Tools" section
  - `kirograph data` commands in "CLI Reference"
  - `enableData` in config table
  - Tool count updated (29 → 37)
- [ ] **CHANGELOG.md** updated: new version entry documenting the full feature
- [ ] **docs/index.html** updated:
  - New feature card: "Data Navigation" with description
  - "Four indexing layers" → "Five indexing layers" (add Data layer)
  - Tool count badge updated
- [ ] **docs/docs.html** updated:
  - New sidebar link: "Data" under "Advanced"
  - New "Data (opt-in)" full section
  - New `enableData` rows in configuration table
  - Quick Start installer prompt list updated
- [ ] **docs/mcp-tools.html** updated: 5 new tool cards with descriptions and parameters

### Phase 2 — Search + Joins + Correlations

- [ ] `kirograph_data_search` — column name + value keyword search
- [ ] Semantic search on column descriptions (embed column summaries, cosine similarity)
- [ ] `kirograph_data_join` — cross-dataset SQL JOIN via `ATTACH DATABASE` (inner, left, right)
- [ ] `kirograph_data_correlations` — pairwise Pearson between numeric columns
- [ ] CLI: `kirograph data search`, `kirograph data join`, `kirograph data correlations`

### Phase 3 — Code Linking + Impact

- [ ] Code ↔ data linker (detect file path references in code: `readFileSync('data/users.csv')`, `pd.read_csv(...)`, `COPY FROM`, etc.)
- [ ] `data_code_refs` population during indexing
- [ ] `kirograph_context` enrichment (opt-in, controlled by `dataContextLimit`)
- [ ] **Data → Code impact**: when a dataset schema changes, identify which code symbols reference it (via `data_code_refs` + `kirograph_impact`)
- [ ] **Test fixture awareness**: if a test imports a data file and that file changes, surface in `kirograph affected`
- [ ] Config: `dataLinkCode`

### Phase 4 — Quality + Drift + History

- [ ] `kirograph_data_quality` — rank columns by risk (null rate, cardinality anomalies, numeric outlier spread)
- [ ] **Schema drift detection**: compare current schema vs previous index (store profile history in `data_dataset_history` table)
- [ ] **Dataset history**: track profile snapshots on each re-index, detect schema/content drift across re-ingests
- [ ] **Validation rules extraction**: from profiles (min/max, null%, type), infer validation rules the code should apply
- [ ] **Sample data generation hints**: from column profiles, provide hints for generating realistic test data
- [ ] NL summaries for datasets and columns (auto-generated from profile patterns)
- [ ] CLI: `kirograph data quality`, `kirograph data history`, `kirograph data drift`

### Phase 5 — Safety + Polish

- [ ] Anti-loop detection (warn when agent paginates row-by-row in a tight loop)
- [ ] Token budget enforcement per response (`dataMaxResponseTokens`)
- [ ] `kirograph data lint` — validate index integrity (row count match, schema consistency, stale locks, missing optional deps)
- [ ] Architecture layer auto-assignment for data files
- [ ] Memory integration (data exploration observations)
- [ ] `kirograph_gain` output updated: 5 source categories (Graph, Docs, Data, Compression, Memory)
- [ ] **README.md** updated
- [ ] **CHANGELOG.md** updated
- [ ] **docs/index.html** updated (feature card, 5 layers, tool count 29 → 37)
- [ ] **docs/docs.html** updated (full section, sidebar, config table)
- [ ] **docs/mcp-tools.html** updated (8 tool cards)

---

## Differences from jDataMunch

| Aspect | jDataMunch | Kirograph Data Module |
|--------|-----------|----------------------|
| Language | Python | TypeScript |
| Storage | Standalone SQLite in `~/.data-index/` | Integrated in kirograph's SQLite DB |
| Code awareness | None | Cross-references data files ↔ code symbols |
| Scope | Any data: local + remote GitHub repos | Project-local data files only |
| Remote indexing | Yes (GitHub API) | No — local files only |
| Formats | CSV, TSV, Excel, Parquet, JSONL | CSV, TSV, JSONL, JSON, Excel, Parquet (Excel/Parquet as optional deps) |
| Joins | Cross-dataset SQL JOIN | Yes — Phase 2 (ATTACH DATABASE pattern) |
| Correlations | Pairwise Pearson | Yes — Phase 2 |
| Semantic search | Embedding-based column search | Yes — Phase 2 (reuses embedding pipeline) |
| Installer | Separate `pip install` + manual config | Same `kirograph install` flow |
| License | Dual (commercial requires paid) | MIT |
| Tool naming | Standalone MCP tools | `kirograph_data_*` (5 tools) |
| Streaming parser | Yes (never loads full file) | Yes (same approach) |
| Token budget | Configurable cap per response | Same |
| Anti-loop detection | Yes | Phase 3 |

---

## Effort Estimate

| Phase | Scope | Estimate |
|-------|-------|----------|
| 1 | Core parsing, profiling, DB, 4 tools, installer | 5–6 days |
| 2 | Search, joins, correlations, semantic search | 3–4 days |
| 3 | Code linking, impact, test fixture awareness | 2–3 days |
| 4 | Quality, drift, history, validation rules, sample hints | 3–4 days |
| 5 | Safety, polish, documentation updates | 2–3 days |
| **Total** | | **15–20 days** |

---

## Resolved Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| D1 | Row storage strategy | **One SQLite table per dataset** (`data_rows_{id}`). Dynamic schema matching source columns. | Enables proper SQL queries with typed columns. EAV would be too slow for aggregations. |
| D2 | Max file size | **50MB default** (`dataMaxFileSize`). | Covers test fixtures, seed data, config tables. Production data (GB+) should use dedicated data tools. |
| D3 | Max rows per query | **500 hard cap** (`dataQueryLimit`). | Prevents context window flooding. Agent can paginate with offset if needed. |
| D4 | Filter injection safety | **Parameterized SQL only.** No raw SQL accepted. Column names validated against schema. | Zero injection surface. Same approach as jDataMunch. |
| D5 | Incremental indexing | **Content hash (SHA-256).** Skip files that haven't changed. | Same pattern as docs module. Fast sync. |
| D6 | Excel/Parquet support | **Optional dependencies.** Core module handles CSV/TSV/JSONL/JSON (zero deps). Excel requires `xlsx`, Parquet requires `parquetjs-lite`. Installer offers to install them. Files with missing deps are silently skipped. | Same pattern as semantic engines (sqlite-vec, orama, etc.) — optional deps that enhance functionality. |
| D7 | Cross-dataset joins | **Not in MVP.** Single-dataset queries only. | Joins add complexity. Can be added in a future phase if demand exists. |
| D8 | Streaming parser | **Yes.** Never load full file into memory. Process in chunks/lines. | Critical for 50MB files. Same approach as jDataMunch. |
| D9 | Token budget | **8000 tokens default per response.** Configurable via `dataMaxResponseTokens`. | Prevents runaway responses. Agent gets structured data, not raw dumps. |
| D10 | Tool naming | **5 separate tools** with `kirograph_data_*` prefix. | Consistent with `kirograph_docs_*` and `kirograph_mem_*`. |
| D11 | Data survival during `kirograph uninit` | **Prompt separately** (same as docs/memory). If user says no, `data_*` tables are preserved. | Data index can be expensive to rebuild for large files. |
| D12 | Context window pressure from data in `kirograph_context` | **Opt-in, disabled by default.** If enabled, user chooses the dataset cap during install. Only surfaces schemas when `dataContextLimit > 0`. | Dataset schemas can be large (many columns). Let the user decide. Same pattern as docs. |
| D13 | Stale code refs after reindex | **Use `qualified_name`** in `data_code_refs` (same as `doc_code_refs` and `mem_links`). Resolve to `node_id` at query time. | Stable across reindex. Cleaned up by `kirograph data lint`. |
| D14 | Dataset ID generation | **Derived from file path**: slugified relative path (e.g. `tests/fixtures/users.csv` → `tests-fixtures-users`). | Readable, stable, unique within project. |

---

## Implementation Order

| Step | Deliverable | Depends On |
|------|-------------|------------|
| 1 | `src/data/types.ts` — type definitions | — |
| 2 | `src/data/parsers/csv.ts` — streaming CSV/TSV parser | Step 1 |
| 3 | `src/data/parsers/jsonl.ts` — JSONL parser | Step 1 |
| 4 | `src/data/parsers/json-array.ts` — JSON array parser | Step 1 |
| 5 | `src/data/parsers/excel.ts` — Excel parser (optional dep) | Step 1 |
| 6 | `src/data/parsers/parquet.ts` — Parquet parser (optional dep) | Step 1 |
| 7 | `src/data/parsers/index.ts` — format registry | Steps 2–6 |
| 8 | `src/data/profiler.ts` — column profiling | Step 1 |
| 9 | `src/data/filters.ts` — filter → SQL builder | Step 1 |
| 10 | `src/db/data-schema.sql` + `applyDataSchema()` | — |
| 11 | Config: `enableData` + validation + defaults (all 9 fields) | — |
| 12 | `src/data/indexer.ts` — orchestrator | Steps 7–11 |
| 13 | `src/data/queries.ts` — read helpers | Steps 9, 10, 12 |
| 14 | MCP tools: 5 tool definitions + dispatch | Steps 12, 13 |
| 15 | Installer: `config-prompt.ts` toggle + optional deps install + `ConfigPatch` + `installLate` | Step 11 |
| 16 | CLI: `src/bin/commands/data.ts` (list, describe, query, aggregate, search, index, reindex) | Steps 12, 13 |
| 17 | Sync pipeline integration | Step 12 |
| 18 | Naive cost heuristics + token tracker `'data'` source | Step 14 |
| 19 | `KIROGRAPH_TOOL_NAMES` + `autoApprove` + steering update | Steps 14, 15 |
| 20 | Build script: copy `data-schema.sql` | Step 10 |
| 21 | `kirograph_status` enhanced with data stats | Steps 12, 13 |
| 22 | Code ↔ data linker (detect file path references in code) | Steps 12, 13 |
| 23 | `data_code_refs` population + `dataLinkCode` config | Step 22 |
| 24 | `kirograph_context` enrichment (opt-in via `dataContextLimit`) | Steps 13, 23 |
| 25 | `kirograph_data_search` (column/value keyword search) | Step 13 |
| 26 | Anti-loop detection + token budget enforcement | Step 13 |
| 27 | `kirograph data lint` — integrity checks | Steps 12, 13 |
| 28 | NL summaries + architecture layer assignment + memory integration | Steps 12, 17 |
| 29 | Documentation: README, CHANGELOG, docs/, help, steering | All |

---

## File Structure

```
src/data/
├── types.ts              # DataSet, DataColumn, QueryFilter, AggregateMetric, DataIndexResult
├── indexer.ts            # DataIndexer — scan, parse, profile, persist
├── profiler.ts           # profileColumns() — type inference, stats, distributions
├── queries.ts            # getDatasets(), describe(), query(), aggregate(), search()
├── filters.ts            # buildWhereClause() — structured filter → parameterized SQL
├── parsers/
│   ├── index.ts          # FormatRegistry — extension → parser dispatch (graceful skip for missing deps)
│   ├── csv.ts            # Streaming CSV/TSV parser (line-by-line, built-in)
│   ├── jsonl.ts          # JSONL/NDJSON parser (line-by-line, built-in)
│   ├── json-array.ts     # JSON array parser (streaming, built-in)
│   ├── excel.ts          # Excel .xlsx/.xls parser (optional dep: xlsx)
│   └── parquet.ts        # Parquet parser (optional dep: parquetjs-lite)
└── lint.ts               # dataLint() — integrity checks

src/bin/commands/
└── data.ts               # CLI: kirograph data {list,describe,query,aggregate,search,index,reindex,lint}
```

---

## Testing & Validation

### Unit Tests

- `src/data/parsers/csv.test.ts` — streaming parse, type detection, edge cases (quoted fields, newlines in values)
- `src/data/profiler.test.ts` — type inference, cardinality, null counting, min/max
- `src/data/filters.test.ts` — all 10 operators, parameterized SQL generation, injection prevention
- `src/data/indexer.test.ts` — full pipeline, incremental detection, max rows cap

### Integration Tests

- Full write path: CSV on disk → parse → profile → rows in SQLite → query returns correct results
- Filter combinations: AND multiple filters, edge cases (empty results, all rows match)
- Aggregation: GROUP BY with various metrics, pre-filters
- Incremental: modify file → re-index → only changed data updated
- Max file size: verify large files are skipped

### Regression Tests

- Existing test suite with `enableData: false` — zero behavior change
- `kirograph index --force` does NOT drop `data_*` tables
- `kirograph uninit` prompts separately for data

---

## Token Savings Analysis

### Without data module

An agent exploring a 10,000-row CSV (typical test fixture):
- Read full file: ~50,000–100,000 tokens
- Grep for a value: ~5,000 tokens (noisy results)
- Re-read on every question: same cost again

### With data module

- `kirograph_data_describe`: ~2,000 tokens (schema + profiles)
- `kirograph_data_query` with filter: ~1,000–3,000 tokens (only matching rows)
- `kirograph_data_aggregate`: ~500–1,500 tokens (computed result)

### Cumulative impact

For a session with 5 data queries:
- **Without**: 250,000–500,000 tokens
- **With**: 5,000–15,000 tokens
- **Savings**: 97–99% reduction

---

## Additional Implementation Gains

### 1. Data-aware context building (opt-in)

When `dataContextLimit > 0`, `kirograph_context` returns not just code symbols but also the schema of data files they reference. An agent modifying `src/importers/product-loader.ts` automatically sees the column structure of `data/products.csv` without a separate tool call.

### 2. Schema drift detection

Because we store column profiles with types and cardinality, and track profile history across re-indexes, we can detect when a data file's schema changes. This powers `kirograph data drift` and could warn when code expects columns that no longer exist.

### 3. Data quality triage

Column profiles include null percentages, cardinality, and type inference. `kirograph_data_quality` ranks columns by composite risk score — an agent can quickly identify problematic columns without loading any rows.

### 4. Server-side computation saves LLM reasoning

Without the data module, an agent that needs "average order value by region" would load all rows into context and reason about them. With `kirograph_data_aggregate`, the computation happens in SQLite and only the result (one row per region) enters the context. This saves both tokens AND reasoning effort.

### 5. Cross-dataset joins without loading either file

`kirograph_data_join` combines two indexed datasets via SQL `ATTACH DATABASE`. The agent gets only the matching rows from both sides — neither file is loaded into context. Critical for projects with relational test data (users + orders, products + categories).

### 6. Correlation discovery

`kirograph_data_correlations` computes pairwise Pearson correlations between all numeric columns. Discovers hidden relationships (e.g., "price correlates strongly with weight") without manual exploration or loading data.

### 7. Data → Code impact analysis

When a dataset schema changes (column renamed, type changed, column removed), kirograph can identify which code symbols reference that dataset via `data_code_refs`. Combined with `kirograph_impact`, this answers: "if I rename the `user_id` column, what breaks?"

### 8. Test fixture awareness

If a test file imports a data file (detected via code linking), and that data file changes, `kirograph affected` can surface the impacted tests. This extends the existing test-impact analysis to cover data dependencies.

### 9. Validation rules extraction

From column profiles (min/max, null%, inferred type, cardinality), the agent can infer what validation rules the code should apply. E.g., "column `age` is integer, range 0–120, never null → validate as required positive integer ≤ 120".

### 10. Sample data generation hints

From column profiles, the agent gets enough information to generate realistic test data without reading the actual file. E.g., "column `email` is string, cardinality 5000, pattern `*@*.com` → generate unique email addresses".

### 11. Gain tool enhancement — new `data` source category

Update `TokenTracker` and `kirograph_gain` to report data savings separately:

```
Token Savings (session):
  Total calls: 52
  Tokens without KiroGraph: ~380,000
  Tokens with KiroGraph:    ~22,000
  Saved: 358,000 tokens (94%)

By source:
  Graph tools: 22 calls, ~48,000 tokens saved (vs file reads/grep)
  Docs tools:  12 calls, ~62,000 tokens saved (vs reading full doc files)
  Data tools:   8 calls, ~235,000 tokens saved (vs loading raw data files)
  Compression:  7 calls, ~9,000 tokens saved (vs raw output)
  Memory:       3 calls, ~4,000 tokens saved (vs re-discovering context)
```

---

## Naming Convention

| Layer | Naming |
|-------|--------|
| MCP tools | `kirograph_data_list`, `kirograph_data_describe`, `kirograph_data_query`, `kirograph_data_aggregate`, `kirograph_data_search`, `kirograph_data_join`, `kirograph_data_correlations`, `kirograph_data_quality` |
| CLI commands | `kirograph data list`, `kirograph data describe`, `kirograph data query`, `kirograph data aggregate`, `kirograph data search`, `kirograph data join`, `kirograph data correlations`, `kirograph data quality`, `kirograph data index`, `kirograph data reindex`, `kirograph data lint`, `kirograph data history`, `kirograph data drift` |
| Config keys | `enableData`, `dataInclude`, `dataExclude`, `dataLinkCode`, `dataContextLimit`, `dataMaxFileSize`, `dataMaxRows`, `dataQueryLimit`, `dataMaxResponseTokens` |
| DB tables | `data_datasets`, `data_columns`, `data_rows_{id}`, `data_code_refs` |
| Internal module | `src/data/` |
| Token tracker source | `'data'` |
