/**
 * KiroGraph Memory — Public API
 *
 * MemoryManager is the single entry point for all memory operations.
 * Coordinates compression, storage, symbol detection, and embedding.
 */

import type { KiroGraphConfig } from '../config';
import type {
  MemObservation,
  MemObservationInput,
  MemSession,
  ScoredObservation,
  MemSearchOptions,
  MemTimelineOptions,
  MemStats,
  CompressResult,
  WatchmenReadyResult,
} from './types';
import { MemoryDatabase } from './database';
import { compressObservation, type CavemanMode } from './compress';
import { detectSymbols } from './symbols';
import { MemoryVectorManager } from './vectors';
import { WatchmenChecker } from '../watchmen';
import { logDebug } from '../errors';

export { MemoryDatabase } from './database';
export { compressObservation, extractIdentifiers, type CavemanMode } from './compress';
export { detectSymbols } from './symbols';
export { MemoryVectorManager } from './vectors';
export * from './types';

// ── MemoryManager ────────────────────────────────────────────────────────────

export class MemoryManager {
  private memDb: MemoryDatabase;
  private vectorMgr: MemoryVectorManager;
  private config: KiroGraphConfig;
  private db: any; // raw sqlite handle for symbol detection
  private cavemanMode: CavemanMode;
  private excludePatterns: string[];
  private watchmenChecker: WatchmenChecker | null;
  private projectRoot: string;

  constructor(config: KiroGraphConfig, db: any, projectRoot = process.cwd()) {
    this.config = config;
    this.db = db;
    this.projectRoot = projectRoot;
    this.memDb = new MemoryDatabase(db);
    this.vectorMgr = new MemoryVectorManager(config, this.memDb);
    this.cavemanMode = (config as any).cavemanMode ?? 'off';
    this.excludePatterns = (config as any).memoryExcludePatterns ?? [];
    this.watchmenChecker = config.enableWatchmen
      ? new WatchmenChecker(config.watchmenThreshold)
      : null;
  }

  /**
   * Initialize memory tables. Must be called before any operations.
   */
  initialize(): void {
    this.memDb.initialize();
  }

  /**
   * Check if memory is enabled in config.
   */
  static isEnabled(config: KiroGraphConfig): boolean {
    return !!(config as any).enableMemory;
  }

  // ── Store ──────────────────────────────────────────────────────────────────

  /**
   * Store an observation. Handles:
   * 1. Privacy stripping (<private> blocks)
   * 2. Exclude pattern checking
   * 3. Caveman compression (if enabled)
   * 4. Deduplication (content hash)
   * 5. Symbol detection and linking
   * 6. Embedding (if enabled)
   * 7. Watchmen threshold check (if enabled) — returns WatchmenReadyResult when synthesis should run
   *
   * Returns the observation ID, a WatchmenReadyResult, or null if skipped (duplicate or excluded).
   */
  async store(input: MemObservationInput, ide = 'kiro'): Promise<string | WatchmenReadyResult | null> {
    let text = input.content;

    // 1. Strip <private> blocks
    text = MemoryDatabase.stripPrivate(text);
    if (!text.trim()) return null;

    // 2. Check exclude patterns
    if (this.shouldExclude(text)) return null;

    // 3. Compress (if caveman is on)
    let contentRaw: string | undefined;
    if (this.cavemanMode !== 'off') {
      const result = compressObservation(text, this.cavemanMode);
      contentRaw = text;
      text = result.compressed;
    }

    // 4. Get or create session
    const cwd = process.cwd();
    const sessionTimeout = (this.config as any).memorySessionTimeout ?? 7200;
    const sessionId = this.memDb.getOrCreateSession(ide, cwd, sessionTimeout);

    // 5. Insert observation (deduplicates via content_hash)
    const id = this.memDb.insertObservation(text, {
      contentRaw: this.cavemanMode !== 'off' ? contentRaw : undefined,
      kind: input.kind ?? 'note',
      source: input.source ?? 'manual',
      tags: input.tags,
      sessionId,
    });

    if (!id) {
      logDebug('Memory: duplicate observation skipped');
      return null;
    }

    // 6. Detect and link symbols
    const symbols = detectSymbols(text, this.db);
    if (symbols.length > 0) {
      this.memDb.linkToSymbols(id, symbols.map(s => s.qualifiedName));
    }

    // Also detect in raw text if different
    if (contentRaw) {
      const rawSymbols = detectSymbols(contentRaw, this.db);
      const extraSymbols = rawSymbols.filter(
        s => !symbols.some(existing => existing.qualifiedName === s.qualifiedName)
      );
      if (extraSymbols.length > 0) {
        this.memDb.linkToSymbols(id, extraSymbols.map(s => s.qualifiedName));
      }
    }

    // 7. Embed (async, non-blocking for the store operation)
    const obs = this.memDb.getObservation(id);
    if (obs) {
      await this.vectorMgr.embedObservation(obs);
    }

    // 8. Watchmen threshold check
    if (this.watchmenChecker && input.kind !== 'summary') {
      const check = this.watchmenChecker.shouldSynthesize(this.memDb);
      if (check.ready) {
        return this.watchmenChecker.buildReadyResponse(id, check.pendingCount, this.projectRoot);
      }
    }

    return id;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Hybrid search: combines FTS5 and vector search with configurable alpha.
   */
  async search(query: string, opts: MemSearchOptions = {}): Promise<ScoredObservation[]> {
    const limit = opts.limit ?? 10;
    const alpha = opts.alpha ?? (this.config as any).memorySearchAlpha ?? 0.5;

    // FTS search
    const ftsResults = this.memDb.searchFTS(query, { ...opts, limit: limit * 2 });

    // Vector search (if enabled and no model mismatch)
    let vectorResults: ScoredObservation[] = [];
    if (this.vectorMgr.isEnabled() && !this.vectorMgr.hasModelMismatch()) {
      vectorResults = await this.vectorMgr.search(query, limit * 2);
    }

    // If only one source has results, return it directly
    if (vectorResults.length === 0) return ftsResults.slice(0, limit);
    if (ftsResults.length === 0) return vectorResults.slice(0, limit);

    // Hybrid merge: normalize scores and blend
    const merged = this.mergeResults(ftsResults, vectorResults, alpha);
    return merged.slice(0, limit);
  }

  /**
   * Get observations linked to specific symbols.
   * Used by kirograph_context and kirograph_impact.
   */
  getLinkedObservations(qualifiedNames: string[], limit = 3, threshold = 0.3): ScoredObservation[] {
    const results = this.memDb.getLinkedObservationsForSymbols(qualifiedNames, limit * 2);
    return results.filter(r => r.score >= threshold).slice(0, limit);
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  /**
   * List sessions with their observation counts.
   */
  timeline(opts: MemTimelineOptions = {}): { sessions: MemSession[]; observations: Map<string, MemObservation[]> } {
    const limit = opts.limit ?? 5;

    if (opts.sessionId) {
      const session = this.memDb.getSession(opts.sessionId);
      if (!session) return { sessions: [], observations: new Map() };
      const obs = this.memDb.getObservationsBySession(opts.sessionId);
      const map = new Map<string, MemObservation[]>();
      map.set(opts.sessionId, obs);
      return { sessions: [session], observations: map };
    }

    const sessions = this.memDb.listSessions(limit);
    const observations = new Map<string, MemObservation[]>();
    for (const session of sessions) {
      const obs = this.memDb.getObservationsBySession(session.id, 10);
      observations.set(session.id, obs);
    }
    return { sessions, observations };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStats(): MemStats {
    const modelName = (this.config as any).embeddingModel ?? 'nomic-ai/nomic-embed-text-v1.5';
    return this.memDb.getStats(modelName);
  }

  // ── Session management ─────────────────────────────────────────────────────

  endCurrentSession(ide = 'kiro'): void {
    const cwd = process.cwd();
    const sessionTimeout = (this.config as any).memorySessionTimeout ?? 7200;
    // Find active session and close it
    const sessionId = this.memDb.getOrCreateSession(ide, cwd, sessionTimeout);
    this.memDb.endSession(sessionId);
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    return this.memDb.prune(cutoff);
  }

  async reembed(batchSize = 32): Promise<number> {
    return this.vectorMgr.reembed(batchSize);
  }

  lint(): { staleLinks: number; modelMismatch: boolean; staleSessions: number } {
    const staleLinks = this.memDb.findStaleLinks().length;
    const modelMismatch = this.vectorMgr.hasModelMismatch();
    const sessionTimeout = ((this.config as any).memorySessionTimeout ?? 7200) * 1000;
    const staleSessions = this.memDb.closeStaleSessionsOlderThan(sessionTimeout);
    return { staleLinks, modelMismatch, staleSessions };
  }

  removeStaleLinks(): number {
    return this.memDb.removeStaleLinks();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private shouldExclude(text: string): boolean {
    if (this.excludePatterns.length === 0) return false;

    // Simple check: if any exclude pattern appears as a substring in the text
    // This is a basic implementation; could use picomatch for glob matching
    for (const pattern of this.excludePatterns) {
      const normalized = pattern.replace(/\*/g, '');
      if (normalized && text.includes(normalized)) return true;
    }
    return false;
  }

  private mergeResults(
    ftsResults: ScoredObservation[],
    vectorResults: ScoredObservation[],
    alpha: number
  ): ScoredObservation[] {
    // Normalize FTS scores (rank is negative in FTS5, lower = better)
    const maxFts = Math.max(...ftsResults.map(r => r.score), 1);
    const normalizedFts = new Map<string, number>();
    for (const r of ftsResults) {
      normalizedFts.set(r.observation.id, r.score / maxFts);
    }

    // Vector scores are already 0-1 (cosine similarity)
    const normalizedVec = new Map<string, number>();
    for (const r of vectorResults) {
      normalizedVec.set(r.observation.id, r.score);
    }

    // Merge: collect all unique observation IDs
    const allIds = new Set([...normalizedFts.keys(), ...normalizedVec.keys()]);
    const merged: ScoredObservation[] = [];

    // Build a lookup for observations
    const obsMap = new Map<string, MemObservation>();
    for (const r of ftsResults) obsMap.set(r.observation.id, r.observation);
    for (const r of vectorResults) obsMap.set(r.observation.id, r.observation);

    for (const id of allIds) {
      const ftsScore = normalizedFts.get(id) ?? 0;
      const vecScore = normalizedVec.get(id) ?? 0;
      const hybridScore = (1 - alpha) * ftsScore + alpha * vecScore;
      const obs = obsMap.get(id)!;
      merged.push({ observation: obs, score: hybridScore, scoreSource: 'hybrid' });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged;
  }
}
