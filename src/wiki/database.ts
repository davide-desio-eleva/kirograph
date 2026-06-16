/**
 * KiroGraph Wiki — Database layer
 *
 * SQLite index for fast FTS over wiki pages.
 * Source of truth is .kirograph/wiki/*.md — this is a regeneratable index.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WikiPage, ScoredWikiPage, WikiStats } from './types';

export class WikiDatabase {
  private db: any;
  private initialized = false;

  constructor(db: any) {
    this.db = db;
  }

  initialize(): void {
    if (this.initialized) return;
    const schemaPath = path.join(__dirname, '../db/wiki-schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(sql);
    this.initialized = true;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  upsertPage(page: Omit<WikiPage, 'updatedAt'> & { updatedAt?: number }): void {
    const now = page.updatedAt ?? Date.now();
    this.db.run(
      `INSERT INTO wiki_pages (slug, title, content, file_path, updated_at, source_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         file_path = excluded.file_path,
         updated_at = excluded.updated_at,
         source_count = wiki_pages.source_count + excluded.source_count`,
      [page.slug, page.title, page.content, page.filePath, now, page.sourceCount ?? 1]
    );
  }

  deletePage(slug: string): void {
    this.db.run('DELETE FROM wiki_pages WHERE slug = ?', [slug]);
  }

  clearAll(): void {
    this.db.exec('DELETE FROM wiki_pages');
  }

  // ── Queue (local synthesis) ───────────────────────────────────────────────

  queueSource(sourceName: string, sourceText: string): void {
    this.db.run(
      'INSERT INTO wiki_queue (source_name, source_text, queued_at) VALUES (?, ?, ?)',
      [sourceName, sourceText, Date.now()]
    );
  }

  getPendingQueue(): Array<{ id: number; sourceName: string; sourceText: string }> {
    const rows = this.db.all('SELECT id, source_name, source_text FROM wiki_queue ORDER BY queued_at ASC') as any[];
    return rows.map(r => ({ id: r.id, sourceName: r.source_name, sourceText: r.source_text }));
  }

  clearQueue(ids?: number[]): void {
    if (ids && ids.length > 0) {
      this.db.exec(`DELETE FROM wiki_queue WHERE id IN (${ids.join(',')})`);
    } else {
      this.db.exec('DELETE FROM wiki_queue');
    }
  }

  getQueueCount(): number {
    const row = this.db.get('SELECT COUNT(*) as count FROM wiki_queue') as any;
    return row?.count ?? 0;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  getPage(slug: string): WikiPage | null {
    const row = this.db.get('SELECT * FROM wiki_pages WHERE slug = ?', [slug]);
    return row ? this.rowToPage(row) : null;
  }

  listPages(): WikiPage[] {
    return (this.db.all('SELECT * FROM wiki_pages ORDER BY slug ASC') as any[]).map(r => this.rowToPage(r));
  }

  search(query: string, limit = 10): ScoredWikiPage[] {
    const safe = query
      .replace(/\b(AND|OR|NOT)\b/g, ' ')
      .replace(/['"*()?\-+^~:{}\\\.\/,\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return [];

    const ftsQuery = safe + '*';
    const safeLimit = Math.max(1, Math.floor(Number(limit)));

    const rows = this.db.all(
      `SELECT p.*, f.rank FROM wiki_fts f
       JOIN wiki_pages p ON p.rowid = f.rowid
       WHERE wiki_fts MATCH '${ftsQuery}'
       ORDER BY f.rank
       LIMIT ${safeLimit}`,
      []
    ) as any[];

    return rows.map(row => ({
      page: this.rowToPage(row),
      score: Math.abs(row.rank ?? 0),
    }));
  }

  getStats(): WikiStats {
    const counts = this.db.get(
      'SELECT COUNT(*) as pageCount, SUM(source_count) as totalSources, MIN(updated_at) as oldest, MAX(updated_at) as newest FROM wiki_pages'
    ) as any;
    return {
      pageCount: counts?.pageCount ?? 0,
      totalSources: counts?.totalSources ?? 0,
      oldestPage: counts?.oldest ?? null,
      newestPage: counts?.newest ?? null,
    };
  }

  private rowToPage(row: any): WikiPage {
    return {
      slug: row.slug,
      title: row.title,
      content: row.content,
      filePath: row.file_path,
      updatedAt: row.updated_at,
      sourceCount: row.source_count ?? 0,
    };
  }
}
