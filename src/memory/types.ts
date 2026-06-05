/**
 * KiroGraph Memory — Type definitions
 */

// ── Session ──────────────────────────────────────────────────────────────────

export interface MemSession {
  id: string;
  ide?: string;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
}

// ── Observation ──────────────────────────────────────────────────────────────

export type ObservationKind = 'decision' | 'error' | 'pattern' | 'architecture' | 'summary' | 'note';
export type ObservationSource = 'hook' | 'manual' | 'agent';

export interface MemObservation {
  id: string;
  sessionId?: string;
  content: string;
  contentRaw?: string;
  contentHash: string;
  kind: ObservationKind;
  source: ObservationSource;
  tags?: string[];
  createdAt: number;
  /** Temporal validity: when this fact became valid (epoch ms). */
  validFrom?: number;
  /** Temporal validity: when this fact expires (epoch ms). Null = no expiry. */
  validUntil?: number;
  /** ID of the observation that supersedes this one. */
  supersededBy?: string;
  /** Fact type for temporal classification. */
  factType?: 'observation' | 'decision' | 'procedure' | 'constraint';
}

export interface MemObservationInput {
  content: string;
  kind?: ObservationKind;
  source?: ObservationSource;
  tags?: string[];
}

// ── Links ────────────────────────────────────────────────────────────────────

export interface MemLink {
  observationId: string;
  qualifiedName: string;
  relevance: number;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface ScoredObservation {
  observation: MemObservation;
  score: number;
  /** Source of the score: 'fts', 'vector', or 'hybrid' */
  scoreSource: 'fts' | 'vector' | 'hybrid';
}

export interface MemSearchOptions {
  limit?: number;
  kind?: ObservationKind;
  sessionId?: string;
  /** FTS/vector blend: 0 = FTS only, 1 = vector only, 0.5 = equal blend */
  alpha?: number;
  /** Query facts valid at this timestamp (epoch ms). Filters out expired/superseded observations. */
  asOf?: number;
}

export interface MemTimelineOptions {
  limit?: number;
  sessionId?: string;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface MemStats {
  sessions: number;
  activeSessions: number;
  observations: number;
  links: number;
  vectors: number;
  embeddableCount: number;
  modelMismatch: boolean;
  currentModel?: string;
}

// ── Watchmen ──────────────────────────────────────────────────────────────────

export interface WatchmenReadyResult {
  id: string;
  watchmenReady: true;
  pendingCount: number;
  /** Synthesis instructions for the active agent. */
  message: string;
  /** Project-relative paths to write the workspace brief to. */
  targetFiles: string[];
}

// ── Compress ─────────────────────────────────────────────────────────────────

export interface CompressResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  detectedSymbols: string[];
}
