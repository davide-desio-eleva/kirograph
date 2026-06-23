/**
 * KiroGraph Data Module — Type Definitions
 *
 * Types for tabular data indexing, profiling, querying, and aggregation.
 * All populated only when enableData=true in config.
 */

// ── Dataset ───────────────────────────────────────────────────────────────────

export interface DataSet {
  id: string;              // derived from file path (slugified)
  filePath: string;        // relative path to data file
  format: 'csv' | 'tsv' | 'jsonl' | 'json' | 'xlsx' | 'parquet' | 'pdf';
  rowCount: number;
  columnCount: number;
  fileSize: number;        // bytes
  contentHash: string;     // SHA-256 for incremental detection
  summary: string | null;  // auto-generated NL summary
  indexedAt: number;
  metadataJson?: string | null; // PDF-specific metadata blob (null for non-PDF formats)
}

// ── Column Profile ────────────────────────────────────────────────────────────

export type InferredType = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'null' | 'mixed';

export interface DataColumn {
  id: string;              // {dataset}::{column_name}#column
  datasetId: string;
  name: string;
  position: number;        // 0-based column order
  inferredType: InferredType;
  nullable: boolean;
  nullCount: number;
  nullPct: number;         // 0.0–1.0
  cardinality: number;     // distinct value count
  minValue: string | null;
  maxValue: string | null;
  meanValue: number | null;
  sampleValues: string[];  // up to 5 sample values
  summary: string | null;  // NL description
  updatedAt: number;
}

// ── Query Filter ──────────────────────────────────────────────────────────────

export interface QueryFilter {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'is_null' | 'between';
  value: any;
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export type AggregateOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';

export interface AggregateMetric {
  column: string;
  op: AggregateOp;
  alias?: string;          // output column name
}

// ── Join ──────────────────────────────────────────────────────────────────────

export interface JoinCondition {
  leftColumn: string;
  rightColumn: string;
}

export type JoinType = 'inner' | 'left' | 'right';

// ── Correlation ───────────────────────────────────────────────────────────────

export interface CorrelationPair {
  column1: string;
  column2: string;
  correlation: number;     // -1.0 to 1.0
  strength: 'strong' | 'moderate' | 'weak' | 'negligible';
}

// ── Code Reference ────────────────────────────────────────────────────────────

export type DataRefType = 'reads' | 'writes' | 'imports' | 'configures';

export interface DataCodeRef {
  datasetId: string;
  qualifiedName: string;   // stable across reindex
  refType: DataRefType;
  confidence: number;      // 0.0–1.0
}

// ── Parser Output ─────────────────────────────────────────────────────────────

export interface ParsedRow {
  [column: string]: string | number | boolean | null;
}

export interface ParseResult {
  columns: string[];       // column names in order
  rows: ParsedRow[];       // parsed rows (may be partial if streaming)
  format: string;
  totalRows: number;
}

// ── Parser Interface ──────────────────────────────────────────────────────────

export interface DataFormatParser {
  name: string;
  extensions: string[];
  /** Check if the optional dependency is available */
  isAvailable(): boolean;
  /** Parse a file, yielding rows in batches via callback */
  parse(filePath: string, opts: { maxRows: number; onBatch: (rows: ParsedRow[], columns: string[]) => void }): Promise<{ columns: string[]; totalRows: number; metadataJson?: string | null }>;
}

// ── Index Result ──────────────────────────────────────────────────────────────

export interface DataIndexResult {
  datasetsIndexed: number;
  rowsIndexed: number;
  columnsProfiled: number;
  errors: string[];
  duration: number;
}

// ── Quality ───────────────────────────────────────────────────────────────────

export interface ColumnQuality {
  column: string;
  riskScore: number;       // 0.0–1.0 composite risk
  nullRisk: number;        // contribution from null rate
  cardinalityRisk: number; // contribution from cardinality anomalies
  typeRisk: number;        // contribution from mixed types
  issues: string[];        // human-readable issue descriptions
}

// ── PixelRAG Visual Search (experimental) ─────────────────────────────────────

export interface VisualSearchResult {
  score: number;
  filePath: string;        // absolute path to source PDF
  tileIndex: number;       // tile index within the page (0-based)
  chunkIndex: number;      // strip index within the page (0-based)
  yOffset: number;         // px from top of page
  chunkHeight: number;     // height of the strip in px
  chunkImagePath: string;  // absolute path to the rendered PNG tile
}

export interface PixelRAGStatus {
  running: boolean;
  endpoint: string;
  indexPath: string | null;
  tileCount: number | null;
  lastBuilt: number | null;  // unix ms
}

export interface PixelRAGManifestEntry {
  path: string;
  mtime: number;
  size: number;
}
