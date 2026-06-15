/**
 * KiroGraph Memory — Database layer
 *
 * Operates on mem_* tables within the same SQLite database as the code graph.
 * Completely isolated: no FK to core nodes/edges tables.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  MemSession,
  MemObservation,
  MemObservationInput,
  MemLink,
  ScoredObservation,
  MemSearchOptions,
  MemTimelineOptions,
  MemStats,
  MemRelation,
  MemRelationInput,
  MemPrompt,
  RelationType,
} from './types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── MemoryDatabase ───────────────────────────────────────────────────────────

export class MemoryDatabase {
  private db: any;
  private initialized = false;

  constructor(db: any) {
    this.db = db;
  }

  /**
   * Apply memory schema. Called once when enableMemory is true.
   */
  initialize(): void {
    if (this.initialized) return;
    const schemaPath = path.join(__dirname, '../db/memory-schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);

    // Migration: add temporal columns if they don't exist (for existing databases)
    this.migrateTemporalColumns();
    this.migrateRelationsAndPrompts();

    this.initialized = true;
  }

  /**
   * Add temporal fact columns to mem_observations if missing.
   * Safe to run multiple times (uses IF NOT EXISTS pattern via try/catch).
   */
  private migrateTemporalColumns(): void {
    const columnsToAdd = [
      { name: 'valid_from', type: 'INTEGER' },
      { name: 'valid_until', type: 'INTEGER' },
      { name: 'superseded_by', type: 'TEXT' },
      { name: 'fact_type', type: "TEXT DEFAULT 'observation'" },
      { name: 'topic_key', type: 'TEXT' },
      { name: 'review_after', type: 'INTEGER' },
    ];

    for (const col of columnsToAdd) {
      try {
        this.db.exec(`ALTER TABLE mem_observations ADD COLUMN ${col.name} ${col.type}`);
      } catch {
        // Column already exists — ignore
      }
    }
  }

  private migrateRelationsAndPrompts(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mem_relations (
        id TEXT PRIMARY KEY,
        observation_a TEXT NOT NULL REFERENCES mem_observations(id) ON DELETE CASCADE,
        observation_b TEXT NOT NULL REFERENCES mem_observations(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        reason TEXT,
        evidence TEXT,
        judgment_status TEXT NOT NULL DEFAULT 'pending',
        judged_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(observation_a, observation_b)
      );
      CREATE INDEX IF NOT EXISTS idx_mem_rel_a ON mem_relations(observation_a);
      CREATE INDEX IF NOT EXISTS idx_mem_rel_b ON mem_relations(observation_b);
      CREATE INDEX IF NOT EXISTS idx_mem_rel_status ON mem_relations(judgment_status);
      CREATE TABLE IF NOT EXISTS mem_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES mem_sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mem_prompts_session ON mem_prompts(session_id);
    `);
  }

  // ── Watchmen ─────────────────────────────────────────────────────────────

  /**
   * Count non-summary observations created after the most recent summary.
   * Used by WatchmenChecker to decide if synthesis should trigger.
   */
  countSinceLastSummary(): number {
    const lastSummary = this.db.get(
      `SELECT created_at FROM mem_observations WHERE kind = 'summary' ORDER BY created_at DESC LIMIT 1`
    ) as { created_at: number } | undefined;

    const since = lastSummary?.created_at ?? 0;
    const row = this.db.get(
      `SELECT COUNT(*) as count FROM mem_observations WHERE kind != 'summary' AND created_at > ?`,
      [since]
    ) as { count: number };

    return row?.count ?? 0;
  }

  getObservationsSinceLastSummary(limit = 50): MemObservation[] {
    const lastSummary = this.db.get(
      `SELECT created_at FROM mem_observations WHERE kind = 'summary' ORDER BY created_at DESC LIMIT 1`
    ) as { created_at: number } | undefined;

    const since = lastSummary?.created_at ?? 0;
    const rows = this.db.all(
      `SELECT * FROM mem_observations WHERE kind != 'summary' AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
      [since, limit]
    ) as any[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id ?? undefined,
      content: row.content,
      contentRaw: row.content_raw ?? undefined,
      contentHash: row.content_hash,
      kind: row.kind,
      source: row.source,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: row.created_at,
    }));
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Get or create an active session. Auto-creates if no active session exists
   * within the timeout window.
   */
  getOrCreateSession(ide: string, cwd: string, timeoutSeconds = 7200): string {
    const cutoff = Date.now() - (timeoutSeconds * 1000);

    // Look for an active session (no ended_at, same ide, started within timeout)
    const existing = this.db.get(
      `SELECT id FROM mem_sessions
       WHERE ended_at IS NULL AND ide = ? AND started_at > ?
       ORDER BY started_at DESC LIMIT 1`,
      [ide, cutoff]
    );

    if (existing) return existing.id;

    // Auto-close any stale sessions for this IDE
    this.db.run(
      `UPDATE mem_sessions SET ended_at = ? WHERE ended_at IS NULL AND ide = ?`,
      [Date.now(), ide]
    );

    // Create new session
    const id = generateId();
    this.db.run(
      `INSERT INTO mem_sessions (id, ide, cwd, started_at) VALUES (?, ?, ?, ?)`,
      [id, ide, cwd, Date.now()]
    );
    return id;
  }

  endSession(sessionId: string): void {
    this.db.run(
      `UPDATE mem_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`,
      [Date.now(), sessionId]
    );
  }

  getSession(sessionId: string): MemSession | null {
    const row = this.db.get('SELECT * FROM mem_sessions WHERE id = ?', [sessionId]);
    return row ? this.rowToSession(row) : null;
  }

  listSessions(limit = 10): MemSession[] {
    return this.db.all(
      'SELECT * FROM mem_sessions ORDER BY started_at DESC LIMIT ?',
      [limit]
    ).map(this.rowToSession);
  }

  // ── Observations ─────────────────────────────────────────────────────────

  /**
   * Insert an observation. Returns the ID, or null if a duplicate (same content_hash).
   */
  insertObservation(
    content: string,
    opts: {
      contentRaw?: string;
      kind?: string;
      source?: string;
      tags?: string[];
      sessionId?: string;
      topicKey?: string;
      reviewAfter?: number;
    } = {}
  ): string | null {
    const id = generateId();
    const contentHash = hashContent(content);
    const kind = opts.kind ?? 'note';
    const source = opts.source ?? 'manual';
    const tags = opts.tags ? JSON.stringify(opts.tags) : null;
    const now = Date.now();

    try {
      this.db.run(
        `INSERT INTO mem_observations (id, session_id, content, content_raw, content_hash, kind, source, tags, created_at, topic_key, review_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, opts.sessionId ?? null, content, opts.contentRaw ?? null, contentHash, kind, source, tags, now, opts.topicKey ?? null, opts.reviewAfter ?? null]
      );
    } catch (err: any) {
      // Unique constraint on content_hash — duplicate, skip silently
      if (err.message?.includes('UNIQUE constraint failed') || err.message?.includes('unique')) {
        return null;
      }
      throw err;
    }

    // Keep FTS in sync
    this.db.run(
      `INSERT INTO mem_fts (id, content, kind) VALUES (?, ?, ?)`,
      [id, content, kind]
    );

    return id;
  }

  getObservation(id: string): MemObservation | null {
    const row = this.db.get('SELECT * FROM mem_observations WHERE id = ?', [id]);
    return row ? this.rowToObservation(row) : null;
  }

  getObservationsBySession(sessionId: string, limit = 50): MemObservation[] {
    return this.db.all(
      'SELECT * FROM mem_observations WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit]
    ).map(this.rowToObservation);
  }

  getObservationsByTimeRange(from: number, to: number, limit = 50): MemObservation[] {
    return this.db.all(
      'SELECT * FROM mem_observations WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?',
      [from, to, limit]
    ).map(this.rowToObservation);
  }

  // ── FTS Search ───────────────────────────────────────────────────────────

  searchFTS(query: string, opts: MemSearchOptions = {}): ScoredObservation[] {
    const { limit = 10, kind, sessionId, asOf } = opts;

    // Sanitize for FTS5
    const safe = query
      .replace(/\b(AND|OR|NOT)\b/g, ' ')
      .replace(/['"*()?\-+^~:{}\\\.\/,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return [];

    const ftsQuery = safe + '*';
    const safeLimit = Math.max(1, Math.floor(Number(limit)));

    const conditions: string[] = [];
    const params: any[] = [];

    if (kind) {
      conditions.push('o.kind = ?');
      params.push(kind);
    }
    if (sessionId) {
      conditions.push('o.session_id = ?');
      params.push(sessionId);
    }

    // Temporal filtering: exclude expired and superseded facts
    if (asOf) {
      conditions.push('(o.valid_from IS NULL OR o.valid_from <= ?)');
      params.push(asOf);
      conditions.push('(o.valid_until IS NULL OR o.valid_until > ?)');
      params.push(asOf);
      conditions.push('o.superseded_by IS NULL');
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const rows = this.db.all(
      `SELECT o.*, rank FROM mem_fts f
       JOIN mem_observations o ON o.id = f.id
       WHERE mem_fts MATCH '${ftsQuery}' ${where}
       ORDER BY rank
       LIMIT ${safeLimit}`,
      params
    );

    return rows.map((row: any) => ({
      observation: this.rowToObservation(row),
      score: Math.abs(row.rank ?? 0),
      scoreSource: 'fts' as const,
    }));
  }

  // ── Links ────────────────────────────────────────────────────────────────

  linkToSymbol(observationId: string, qualifiedName: string, relevance = 1.0): void {
    this.db.run(
      `INSERT OR IGNORE INTO mem_links (observation_id, qualified_name, relevance)
       VALUES (?, ?, ?)`,
      [observationId, qualifiedName, relevance]
    );
  }

  linkToSymbols(observationId: string, qualifiedNames: string[]): void {
    for (const qn of qualifiedNames) {
      this.linkToSymbol(observationId, qn);
    }
  }

  /**
   * Get observations linked to a symbol by qualified_name.
   * Resolves through mem_links — no dependency on node IDs.
   */
  getLinkedObservations(qualifiedName: string, limit = 10): ScoredObservation[] {
    const rows = this.db.all(
      `SELECT o.*, l.relevance FROM mem_observations o
       JOIN mem_links l ON l.observation_id = o.id
       WHERE l.qualified_name = ?
       ORDER BY l.relevance DESC, o.created_at DESC
       LIMIT ?`,
      [qualifiedName, limit]
    );

    return rows.map((row: any) => ({
      observation: this.rowToObservation(row),
      score: row.relevance ?? 1.0,
      scoreSource: 'fts' as const,
    }));
  }

  /**
   * Get observations linked to any of the given qualified names.
   * Used by kirograph_context and kirograph_impact to surface memory.
   */
  getLinkedObservationsForSymbols(qualifiedNames: string[], limit = 5): ScoredObservation[] {
    if (qualifiedNames.length === 0) return [];
    const placeholders = qualifiedNames.map(() => '?').join(',');
    const rows = this.db.all(
      `SELECT DISTINCT o.*, MAX(l.relevance) as relevance FROM mem_observations o
       JOIN mem_links l ON l.observation_id = o.id
       WHERE l.qualified_name IN (${placeholders})
       GROUP BY o.id
       ORDER BY relevance DESC, o.created_at DESC
       LIMIT ?`,
      [...qualifiedNames, limit]
    );

    return rows.map((row: any) => ({
      observation: this.rowToObservation(row),
      score: row.relevance ?? 1.0,
      scoreSource: 'fts' as const,
    }));
  }

  // ── Vectors ──────────────────────────────────────────────────────────────

  insertVector(observationId: string, embedding: Buffer, model: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO mem_vectors (observation_id, embedding, model, created_at)
       VALUES (?, ?, ?, ?)`,
      [observationId, embedding, model, Date.now()]
    );
  }

  getVector(observationId: string): { embedding: Buffer; model: string } | null {
    const row = this.db.get(
      'SELECT embedding, model FROM mem_vectors WHERE observation_id = ?',
      [observationId]
    );
    return row ? { embedding: row.embedding, model: row.model } : null;
  }

  getVectorCount(): number {
    const row = this.db.get('SELECT COUNT(*) as count FROM mem_vectors');
    return row?.count ?? 0;
  }

  getVectorModelMismatch(currentModel: string): number {
    const row = this.db.get(
      'SELECT COUNT(*) as count FROM mem_vectors WHERE model != ?',
      [currentModel]
    );
    return row?.count ?? 0;
  }

  getAllVectors(model?: string): Array<{ observationId: string; embedding: Buffer }> {
    const sql = model
      ? 'SELECT observation_id, embedding FROM mem_vectors WHERE model = ?'
      : 'SELECT observation_id, embedding FROM mem_vectors';
    const params = model ? [model] : [];
    return this.db.all(sql, params).map((row: any) => ({
      observationId: row.observation_id,
      embedding: row.embedding,
    }));
  }

  deleteVectors(): void {
    this.db.run('DELETE FROM mem_vectors');
  }

  // ── Relations ────────────────────────────────────────────────────────────

  insertRelation(input: MemRelationInput): string {
    const id = generateId();
    this.db.run(
      `INSERT OR REPLACE INTO mem_relations (id, observation_a, observation_b, relation, confidence, reason, evidence, judgment_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, input.observationA, input.observationB, input.relation, input.confidence ?? 1.0, input.reason ?? null, input.evidence ?? null, Date.now()]
    );
    return id;
  }

  judgeRelation(id: string, relation: RelationType, confidence: number, reason?: string, evidence?: string): void {
    this.db.run(
      `UPDATE mem_relations SET relation = ?, confidence = ?, reason = ?, evidence = ?, judgment_status = 'judged', judged_at = ? WHERE id = ?`,
      [relation, confidence, reason ?? null, evidence ?? null, Date.now(), id]
    );
  }

  ignoreRelation(id: string): void {
    this.db.run(`UPDATE mem_relations SET judgment_status = 'ignored' WHERE id = ?`, [id]);
  }

  getPendingRelations(limit = 20): MemRelation[] {
    return this.db.all(
      `SELECT * FROM mem_relations WHERE judgment_status = 'pending' ORDER BY created_at DESC LIMIT ?`,
      [limit]
    ).map((row: any) => this.rowToRelation(row));
  }

  getRelationsForObservations(ids: string[]): Map<string, MemRelation[]> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.all(
      `SELECT * FROM mem_relations WHERE observation_a IN (${placeholders}) OR observation_b IN (${placeholders})`,
      [...ids, ...ids]
    ) as any[];
    const map = new Map<string, MemRelation[]>();
    for (const row of rows) {
      const rel = this.rowToRelation(row);
      for (const obsId of [row.observation_a, row.observation_b]) {
        if (ids.includes(obsId)) {
          if (!map.has(obsId)) map.set(obsId, []);
          map.get(obsId)!.push(rel);
        }
      }
    }
    return map;
  }

  resolveObservationByTopicKey(topicKey: string): MemObservation | null {
    const row = this.db.get('SELECT * FROM mem_observations WHERE topic_key = ? LIMIT 1', [topicKey]);
    return row ? this.rowToObservation(row) : null;
  }

  private rowToRelation(row: any): MemRelation {
    return {
      id: row.id,
      observationA: row.observation_a,
      observationB: row.observation_b,
      relation: row.relation,
      confidence: row.confidence,
      reason: row.reason ?? undefined,
      evidence: row.evidence ?? undefined,
      judgmentStatus: row.judgment_status,
      judgedAt: row.judged_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ── Review ────────────────────────────────────────────────────────────────

  getObservationsForReview(limit = 20): MemObservation[] {
    const now = Date.now();
    return this.db.all(
      `SELECT * FROM mem_observations WHERE review_after IS NOT NULL AND review_after < ? AND superseded_by IS NULL ORDER BY review_after ASC LIMIT ?`,
      [now, limit]
    ).map((row: any) => this.rowToObservation(row));
  }

  markReviewed(id: string): void {
    this.db.run(`UPDATE mem_observations SET review_after = NULL WHERE id = ?`, [id]);
  }

  // ── Prompts ───────────────────────────────────────────────────────────────

  insertPrompt(sessionId: string | undefined, content: string): string {
    const id = generateId();
    this.db.run(
      `INSERT INTO mem_prompts (id, session_id, content, created_at) VALUES (?, ?, ?, ?)`,
      [id, sessionId ?? null, content, Date.now()]
    );
    return id;
  }

  getPromptsBySession(sessionId: string, limit = 20): MemPrompt[] {
    return this.db.all(
      `SELECT * FROM mem_prompts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      [sessionId, limit]
    ).map((row: any) => ({ id: row.id, sessionId: row.session_id ?? undefined, content: row.content, createdAt: row.created_at }));
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getStats(currentModel?: string): MemStats {
    const sessions = this.db.get('SELECT COUNT(*) as c FROM mem_sessions')?.c ?? 0;
    const activeSessions = this.db.get('SELECT COUNT(*) as c FROM mem_sessions WHERE ended_at IS NULL')?.c ?? 0;
    const observations = this.db.get('SELECT COUNT(*) as c FROM mem_observations')?.c ?? 0;
    const links = this.db.get('SELECT COUNT(*) as c FROM mem_links')?.c ?? 0;
    const vectors = this.db.get('SELECT COUNT(*) as c FROM mem_vectors')?.c ?? 0;
    const mismatch = currentModel ? this.getVectorModelMismatch(currentModel) : 0;
    const relations = this.db.get('SELECT COUNT(*) as c FROM mem_relations')?.c ?? 0;
    const pendingConflicts = this.db.get("SELECT COUNT(*) as c FROM mem_relations WHERE judgment_status = 'pending'")?.c ?? 0;

    return {
      sessions,
      activeSessions,
      observations,
      links,
      vectors,
      embeddableCount: observations,
      modelMismatch: mismatch > 0,
      currentModel,
      relations,
      pendingConflicts,
    };
  }

  // ── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Delete observations older than the given timestamp.
   * Cascades to mem_links and mem_vectors via FK.
   */
  prune(olderThan: number): number {
    // Get IDs to delete (for FTS cleanup)
    const ids = this.db.all(
      'SELECT id FROM mem_observations WHERE created_at < ?',
      [olderThan]
    ).map((r: any) => r.id);

    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM mem_fts WHERE id IN (${placeholders})`, ids);
    this.db.run(`DELETE FROM mem_observations WHERE created_at < ?`, [olderThan]);

    // Clean up empty sessions
    this.db.run(
      `DELETE FROM mem_sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM mem_observations WHERE session_id IS NOT NULL)`
    );

    return ids.length;
  }

  /**
   * Find stale links where qualified_name no longer exists in the nodes table.
   */
  findStaleLinks(): MemLink[] {
    const rows = this.db.all(
      `SELECT l.* FROM mem_links l
       LEFT JOIN nodes n ON n.qualified_name = l.qualified_name
       WHERE n.id IS NULL`
    );
    return rows.map((row: any) => ({
      observationId: row.observation_id,
      qualifiedName: row.qualified_name,
      relevance: row.relevance,
    }));
  }

  /**
   * Remove stale links (where qualified_name no longer resolves).
   */
  removeStaleLinks(): number {
    const result = this.db.run(
      `DELETE FROM mem_links WHERE qualified_name NOT IN (SELECT DISTINCT qualified_name FROM nodes)`
    );
    return result?.changes ?? 0;
  }

  /**
   * Close stale sessions (started but never ended, older than timeout).
   */
  closeStaleSessionsOlderThan(timeoutMs: number): number {
    const cutoff = Date.now() - timeoutMs;
    const result = this.db.run(
      `UPDATE mem_sessions SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?`,
      [Date.now(), cutoff]
    );
    return result?.changes ?? 0;
  }

  // ── Privacy ──────────────────────────────────────────────────────────────

  /**
   * Strip <private>...</private> blocks from text.
   */
  static stripPrivate(text: string): string {
    return text.replace(/<private>[\s\S]*?<\/private>/gi, '').trim();
  }

  // ── Row mappers ──────────────────────────────────────────────────────────

  private rowToSession(row: any): MemSession {
    return {
      id: row.id,
      ide: row.ide ?? undefined,
      cwd: row.cwd ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
    };
  }

  private rowToObservation(row: any): MemObservation {
    return {
      id: row.id,
      sessionId: row.session_id ?? undefined,
      content: row.content,
      contentRaw: row.content_raw ?? undefined,
      contentHash: row.content_hash,
      kind: row.kind,
      source: row.source,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: row.created_at,
      validFrom: row.valid_from ?? undefined,
      validUntil: row.valid_until ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      factType: row.fact_type ?? undefined,
      topicKey: row.topic_key ?? undefined,
      reviewAfter: row.review_after ?? undefined,
    };
  }
}
