/**
 * Documentation Queries
 *
 * Read-side helpers for MCP tools and CLI commands.
 * All methods operate on the doc_sections and doc_code_refs tables.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocSection, DocTocEntry, DocSearchResult } from './types';
import type { KiroGraphConfig } from '../config';
import { parseSectionId } from './section-id';
import { DocsVectorManager } from './vectors';

export class DocsQueries {
  private readonly db: any;
  private readonly projectRoot: string;
  private readonly config: KiroGraphConfig | null;

  constructor(db: any, projectRoot: string, config?: KiroGraphConfig) {
    this.db = db;
    this.projectRoot = projectRoot;
    this.config = config ?? null;
  }

  // ── TOC ─────────────────────────────────────────────────────────────────────

  /**
   * Get table of contents for a file or the whole project.
   */
  getToc(opts?: { file?: string; tree?: boolean }): DocTocEntry[] {
    const where = opts?.file ? 'WHERE file_path = ?' : '';
    const params = opts?.file ? [opts.file] : [];

    const rows = this.db.all(`
      SELECT id, title, level, file_path, summary, parent_id
      FROM doc_sections
      ${where}
      ORDER BY file_path, position
    `, params) as Array<{
      id: string; title: string; level: number;
      file_path: string; summary: string | null; parent_id: string | null;
    }>;

    if (!opts?.tree) {
      // Flat list
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        level: r.level,
        filePath: r.file_path,
        summary: r.summary,
      }));
    }

    // Build tree
    return this.buildTocTree(rows);
  }

  /**
   * Get heading hierarchy for a single document.
   */
  getOutline(file: string): DocTocEntry[] {
    return this.getToc({ file, tree: true });
  }

  // ── Section Retrieval ───────────────────────────────────────────────────────

  /**
   * Get a section by ID, optionally with context (ancestor chain + child summaries).
   */
  getSection(id: string, opts?: { context?: boolean }): {
    section: DocSection;
    content: string;
    ancestors?: Array<{ id: string; title: string; level: number }>;
    children?: Array<{ id: string; title: string; summary: string | null }>;
  } | null {
    const row = this.db.get('SELECT * FROM doc_sections WHERE id = ?', [id]);
    if (!row) return null;

    const section = this.rowToSection(row);
    const content = this.readSectionContent(section);

    if (!opts?.context) {
      return { section, content };
    }

    // Build ancestor chain
    const ancestors: Array<{ id: string; title: string; level: number }> = [];
    let currentParent = section.parentId;
    while (currentParent) {
      const parent = this.db.get('SELECT id, title, level, parent_id FROM doc_sections WHERE id = ?', [currentParent]);
      if (!parent) break;
      ancestors.unshift({ id: parent.id, title: parent.title, level: parent.level });
      currentParent = parent.parent_id;
    }

    // Get child summaries
    const childRows = this.db.all(
      'SELECT id, title, summary FROM doc_sections WHERE parent_id = ? ORDER BY position',
      [id]
    ) as Array<{ id: string; title: string; summary: string | null }>;

    return { section, content, ancestors, children: childRows };
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search sections by query using FTS5 + optional vector search (hybrid).
   */
  async searchSections(query: string, opts?: { file?: string; limit?: number }): Promise<DocSearchResult[]> {
    const limit = opts?.limit ?? 10;

    // FTS search
    const ftsResults = this.searchFTS(query, opts?.file, limit);

    // Vector search (if embeddings enabled)
    if (this.config?.enableEmbeddings) {
      try {
        const vectorMgr = new DocsVectorManager(this.config, this.db);
        const vectorResults = await vectorMgr.search(query, limit);

        if (vectorResults.length > 0) {
          // Merge FTS + vector results with alpha blend
          const alpha = 0.5; // 0 = pure FTS, 1 = pure vector
          const merged = new Map<string, { section: DocSection; score: number; matchType: 'fts' | 'semantic' }>();

          // Add FTS results
          for (const r of ftsResults) {
            merged.set(r.section.id, { section: r.section, score: r.score * (1 - alpha), matchType: 'fts' });
          }

          // Add/merge vector results
          for (const vr of vectorResults) {
            const existing = merged.get(vr.sectionId);
            if (existing) {
              existing.score += vr.score * alpha;
              existing.matchType = 'semantic'; // promoted to semantic if both match
            } else {
              // Fetch section from DB
              const row = this.db.get('SELECT * FROM doc_sections WHERE id = ?', [vr.sectionId]);
              if (row) {
                // Filter by file if specified
                if (opts?.file && row.file_path !== opts.file) continue;
                merged.set(vr.sectionId, {
                  section: this.rowToSection(row),
                  score: vr.score * alpha,
                  matchType: 'semantic',
                });
              }
            }
          }

          // Sort by merged score, return top N
          const sorted = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
          return sorted;
        }
      } catch { /* vector search is non-critical, fall through to FTS-only */ }
    }

    return ftsResults;
  }

  /**
   * FTS-only search (used internally and as fallback).
   */
  private searchFTS(query: string, file: string | undefined, limit: number): DocSearchResult[] {

    // Sanitize query for FTS5
    const sanitized = query
      .replace(/[",]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!sanitized) return [];

    let sql: string;
    let params: any[];

    if (file) {
      sql = `
        SELECT s.*, rank
        FROM doc_sections_fts fts
        JOIN doc_sections s ON s.id = fts.id
        WHERE doc_sections_fts MATCH ? AND s.file_path = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, file, limit];
    } else {
      sql = `
        SELECT s.*, rank
        FROM doc_sections_fts fts
        JOIN doc_sections s ON s.id = fts.id
        WHERE doc_sections_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, limit];
    }

    try {
      const rows = this.db.all(sql, params) as any[];
      return rows.map(row => ({
        section: this.rowToSection(row),
        score: Math.abs(row.rank ?? 0),
        matchType: 'fts' as const,
      }));
    } catch {
      // FTS query syntax error — fall back to LIKE search
      return this.searchFallback(sanitized, file, limit);
    }
  }

  // ── Code Refs ───────────────────────────────────────────────────────────────

  /**
   * Get code symbols referenced by a section, or doc sections that reference a symbol.
   */
  getRefs(opts: { sectionId?: string; qualifiedName?: string }): Array<{
    sectionId: string;
    qualifiedName: string;
    refType: string;
    confidence: number;
    sectionTitle?: string;
  }> {
    if (opts.sectionId) {
      return this.db.all(`
        SELECT r.*, s.title as section_title
        FROM doc_code_refs r
        JOIN doc_sections s ON s.id = r.section_id
        WHERE r.section_id = ?
        ORDER BY r.confidence DESC
      `, [opts.sectionId]).map((r: any) => ({
        sectionId: r.section_id,
        qualifiedName: r.qualified_name,
        refType: r.ref_type,
        confidence: r.confidence,
        sectionTitle: r.section_title,
      }));
    }

    if (opts.qualifiedName) {
      return this.db.all(`
        SELECT r.*, s.title as section_title
        FROM doc_code_refs r
        JOIN doc_sections s ON s.id = r.section_id
        WHERE r.qualified_name = ?
        ORDER BY r.confidence DESC
      `, [opts.qualifiedName]).map((r: any) => ({
        sectionId: r.section_id,
        qualifiedName: r.qualified_name,
        refType: r.ref_type,
        confidence: r.confidence,
        sectionTitle: r.section_title,
      }));
    }

    return [];
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats(): { files: number; sections: number; codeRefs: number } {
    const files = this.db.get('SELECT COUNT(DISTINCT file_path) as cnt FROM doc_sections')?.cnt ?? 0;
    const sections = this.db.get('SELECT COUNT(*) as cnt FROM doc_sections')?.cnt ?? 0;
    const codeRefs = this.db.get('SELECT COUNT(*) as cnt FROM doc_code_refs')?.cnt ?? 0;
    return { files, sections, codeRefs };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private rowToSection(row: any): DocSection {
    return {
      id: row.id,
      filePath: row.file_path,
      title: row.title,
      level: row.level,
      parentId: row.parent_id ?? null,
      summary: row.summary ?? null,
      byteStart: row.byte_start,
      byteEnd: row.byte_end,
      contentHash: row.content_hash,
      tags: row.tags ? JSON.parse(row.tags) : [],
      position: row.position,
      updatedAt: row.updated_at,
    };
  }

  private readSectionContent(section: DocSection): string {
    const absPath = path.join(this.projectRoot, section.filePath);
    try {
      const buffer = fs.readFileSync(absPath);
      return buffer.slice(section.byteStart, section.byteEnd).toString('utf8');
    } catch {
      return '(file not found on disk)';
    }
  }

  private buildTocTree(rows: Array<{
    id: string; title: string; level: number;
    file_path: string; summary: string | null; parent_id: string | null;
  }>): DocTocEntry[] {
    const map = new Map<string, DocTocEntry>();
    const roots: DocTocEntry[] = [];

    for (const row of rows) {
      const entry: DocTocEntry = {
        id: row.id,
        title: row.title,
        level: row.level,
        filePath: row.file_path,
        summary: row.summary,
        children: [],
      };
      map.set(row.id, entry);

      if (!row.parent_id || !map.has(row.parent_id)) {
        roots.push(entry);
      } else {
        map.get(row.parent_id)!.children!.push(entry);
      }
    }

    return roots;
  }

  private searchFallback(query: string, file: string | undefined, limit: number): DocSearchResult[] {
    const pattern = `%${query}%`;
    let sql: string;
    let params: any[];

    if (file) {
      sql = 'SELECT * FROM doc_sections WHERE file_path = ? AND (title LIKE ? OR summary LIKE ?) LIMIT ?';
      params = [file, pattern, pattern, limit];
    } else {
      sql = 'SELECT * FROM doc_sections WHERE title LIKE ? OR summary LIKE ? LIMIT ?';
      params = [pattern, pattern, limit];
    }

    const rows = this.db.all(sql, params) as any[];
    return rows.map(row => ({
      section: this.rowToSection(row),
      score: 1.0,
      matchType: 'fts' as const,
    }));
  }
}
