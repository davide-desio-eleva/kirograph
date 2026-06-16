/**
 * KiroGraph Wiki — Public API
 */

import * as fs from 'fs';
import * as path from 'path';
import { WikiDatabase } from './database';
import { DEFAULT_SCHEMA } from './schema';
import { parseWikiDiff } from './schema';
import { buildIngestPrompt, applyDiff, reindexFromDisk, updateManifest } from './ingest';
import { lintWiki } from './lint';
import type {
  WikiPage,
  ScoredWikiPage,
  WikiDiff,
  WikiLintIssue,
  WikiStats,
} from './types';

export type { WikiPage, ScoredWikiPage, WikiDiff, WikiLintIssue, WikiStats };

export class KiroGraphWiki {
  private wikiDb: WikiDatabase;
  private wikiDir: string;
  private autoResolveConflicts: boolean;

  constructor(
    db: any,
    kirographDir: string,
    opts: { autoResolveConflicts?: boolean } = {}
  ) {
    this.wikiDb = new WikiDatabase(db);
    this.wikiDir = path.join(kirographDir, 'wiki');
    this.autoResolveConflicts = opts.autoResolveConflicts ?? false;
  }

  initialize(): void {
    this.wikiDb.initialize();
    fs.mkdirSync(this.wikiDir, { recursive: true });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  initWiki(): void {
    this.initialize();
    const schemaPath = path.join(this.wikiDir, 'SCHEMA.md');
    if (!fs.existsSync(schemaPath)) {
      fs.writeFileSync(schemaPath, DEFAULT_SCHEMA, 'utf8');
    }
    const manifestPath = path.join(this.wikiDir, 'MANIFEST.md');
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, '# Wiki Manifest\n\n(empty)\n', 'utf8');
    }
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────

  /**
   * Returns the ingest prompt for the LLM (agent mode).
   * The agent uses this to produce a WIKI_DIFF, then calls applyDiff.
   */
  getIngestPrompt(source: string, sourceName = 'source'): string {
    this.initialize();
    return buildIngestPrompt(this.wikiDir, source, sourceName);
  }

  // ── Queue (local synthesis mode) ──────────────────────────────────────────

  queueSource(sourceText: string, sourceName: string): void {
    this.initialize();
    this.wikiDb.queueSource(sourceName, sourceText);
  }

  getPendingQueue(): Array<{ id: number; sourceName: string; sourceText: string }> {
    this.initialize();
    return this.wikiDb.getPendingQueue();
  }

  clearQueue(): void {
    this.initialize();
    this.wikiDb.clearQueue();
  }

  getQueueCount(): number {
    this.initialize();
    return this.wikiDb.getQueueCount();
  }

  async synthesize(modelName: string, quiet = false) {
    this.initialize();
    const { runWikiLocalSynthesis } = await import('./synthesize');
    return runWikiLocalSynthesis(this, modelName, quiet);
  }

  /**
   * Parse and apply a WIKI_DIFF string produced by the LLM.
   */
  applyDiff(rawDiff: string) {
    this.initialize();
    const diff = parseWikiDiff(rawDiff);
    return applyDiff(diff, this.wikiDir, this.wikiDb, {
      autoResolveConflicts: this.autoResolveConflicts,
    });
  }

  // ── Search & Read ──────────────────────────────────────────────────────────

  search(query: string, limit = 10): ScoredWikiPage[] {
    this.initialize();
    return this.wikiDb.search(query, limit);
  }

  getPage(slug: string): WikiPage | null {
    this.initialize();
    return this.wikiDb.getPage(slug);
  }

  listPages(): WikiPage[] {
    this.initialize();
    return this.wikiDb.listPages();
  }

  // ── Lint ───────────────────────────────────────────────────────────────────

  lint(): WikiLintIssue[] {
    this.initialize();
    return lintWiki(this.wikiDb);
  }

  // ── Reindex ────────────────────────────────────────────────────────────────

  reindex(): number {
    this.initialize();
    return reindexFromDisk(this.wikiDir, this.wikiDb);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): WikiStats {
    this.initialize();
    return this.wikiDb.getStats();
  }

  // ── Context enrichment ────────────────────────────────────────────────────

  /**
   * Returns wiki pages relevant to a query, for inclusion in kirograph_context.
   * Returns up to `limit` pages with score >= threshold.
   */
  getContextPages(query: string, limit = 3, threshold = 0.4): WikiPage[] {
    this.initialize();
    return this.wikiDb
      .search(query, limit * 2)
      .filter(r => r.score >= threshold)
      .slice(0, limit)
      .map(r => r.page);
  }

  get dir(): string {
    return this.wikiDir;
  }
}
