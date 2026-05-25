/**
 * Documentation Indexer
 *
 * Orchestrates: scan doc files → parse sections → persist to DB.
 * Supports incremental re-indexing via content hashes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import picomatch from 'picomatch';
import type { KiroGraphConfig } from '../config';
import type { DocSection, ParsedSection, DocIndexResult } from './types';
import { generateSectionId, slugify } from './section-id';
import { parseDocFile } from './formats/index';
import { linkSection } from './linker';
import { DocsVectorManager } from './vectors';

// ── Public API ────────────────────────────────────────────────────────────────

export class DocsIndexer {
  private readonly db: any; // raw sqlite db handle
  private readonly config: KiroGraphConfig;
  private readonly projectRoot: string;

  constructor(db: any, config: KiroGraphConfig, projectRoot: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /**
   * Index all documentation files in the project.
   * Skips files whose content hash hasn't changed (incremental).
   */
  async indexAll(opts?: { force?: boolean; onProgress?: (msg: string) => void }): Promise<DocIndexResult> {
    const start = Date.now();
    const result: DocIndexResult = {
      filesIndexed: 0, sectionsCreated: 0, sectionsUpdated: 0,
      sectionsRemoved: 0, codeRefsCreated: 0, errors: [], duration: 0,
    };

    const files = this.scanDocFiles();
    opts?.onProgress?.(`docs: found ${files.length} documentation files`);

    for (const relPath of files) {
      try {
        const changed = await this.indexFile(relPath, opts?.force ?? false);
        if (changed) {
          result.filesIndexed++;
          result.sectionsCreated += changed.created;
          result.sectionsUpdated += changed.updated;
          result.sectionsRemoved += changed.removed;
          result.codeRefsCreated += changed.codeRefs;
        }
      } catch (err) {
        result.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Remove sections for files that no longer exist
    const removedFromDeleted = this.removeDeletedFiles(files);
    result.sectionsRemoved += removedFromDeleted;

    // Embed all sections (if embeddings enabled)
    if (this.config.enableEmbeddings) {
      try {
        opts?.onProgress?.('docs: embedding sections');
        const vectorMgr = new DocsVectorManager(this.config, this.db);
        const allSections = this.db.all('SELECT * FROM doc_sections ORDER BY file_path, position') as any[];
        const sections: DocSection[] = allSections.map((row: any) => ({
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
        }));
        await vectorMgr.embedBatch(sections);
      } catch { /* embedding is non-critical */ }
    }

    result.duration = Date.now() - start;
    return result;
  }

  /**
   * Index a single file. Returns null if unchanged (hash match).
   */
  async indexFile(relPath: string, force = false): Promise<{ created: number; updated: number; removed: number; codeRefs: number } | null> {
    const absPath = path.join(this.projectRoot, relPath);
    if (!fs.existsSync(absPath)) return null;

    const stat = fs.statSync(absPath);
    if (stat.size > this.config.docsMaxFileSize) return null;

    const content = fs.readFileSync(absPath, 'utf8');
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');

    // Check if file has changed (skip if hash matches and not forced)
    if (!force) {
      const existing = this.db.get(
        'SELECT content_hash FROM doc_sections WHERE file_path = ? LIMIT 1',
        [relPath]
      );
      // If any section exists with same file and we can verify the file hasn't changed
      if (existing) {
        const allSections = this.db.all(
          'SELECT content_hash FROM doc_sections WHERE file_path = ?',
          [relPath]
        );
        // Use a file-level hash stored as a tag on the first section
        const firstSection = this.db.get(
          "SELECT tags FROM doc_sections WHERE file_path = ? AND parent_id IS NULL LIMIT 1",
          [relPath]
        );
        if (firstSection?.tags) {
          try {
            const tags = JSON.parse(firstSection.tags);
            if (tags._fileHash === fileHash) return null; // unchanged
          } catch { /* proceed with re-index */ }
        }
      }
    }

    // Parse the file
    const parseResult = parseDocFile(content, relPath);
    if (!parseResult) return null;

    // Flatten sections and generate IDs
    const flatSections = this.flattenSections(parseResult.sections, relPath, fileHash);

    // Get existing section IDs for this file
    const existingIds = new Set<string>(
      (this.db.all('SELECT id FROM doc_sections WHERE file_path = ?', [relPath]) as Array<{ id: string }>)
        .map(r => r.id)
    );

    let created = 0;
    let updated = 0;
    let codeRefsCount = 0;

    // Upsert sections in a transaction
    this.db.run('BEGIN');
    try {
      for (const section of flatSections) {
        if (existingIds.has(section.id)) {
          // Update existing
          this.db.run(`
            UPDATE doc_sections SET
              title = ?, level = ?, parent_id = ?, summary = ?,
              byte_start = ?, byte_end = ?, content_hash = ?,
              tags = ?, position = ?, updated_at = ?
            WHERE id = ?
          `, [
            section.title, section.level, section.parentId, section.summary,
            section.byteStart, section.byteEnd, section.contentHash,
            JSON.stringify(section.tags), section.position, section.updatedAt,
            section.id,
          ]);
          existingIds.delete(section.id);
          updated++;
        } else {
          // Insert new
          this.db.run(`
            INSERT INTO doc_sections (id, file_path, title, level, parent_id, summary, byte_start, byte_end, content_hash, tags, position, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            section.id, section.filePath, section.title, section.level,
            section.parentId, section.summary, section.byteStart, section.byteEnd,
            section.contentHash, JSON.stringify(section.tags), section.position, section.updatedAt,
          ]);
          created++;
        }

        // Update FTS
        this.db.run('INSERT OR REPLACE INTO doc_sections_fts (id, title, summary) VALUES (?, ?, ?)', [
          section.id, section.title, section.summary ?? '',
        ]);
      }

      // Remove sections that no longer exist in the file
      for (const staleId of existingIds) {
        this.db.run('DELETE FROM doc_sections WHERE id = ?', [staleId]);
        this.db.run('DELETE FROM doc_sections_fts WHERE id = ?', [staleId]);
        this.db.run('DELETE FROM doc_code_refs WHERE section_id = ?', [staleId]);
      }

      // Run code linker if enabled
      if (this.config.docsLinkCode) {
        for (const section of flatSections) {
          // Read section content for linking
          const sectionContent = Buffer.from(content, 'utf8')
            .slice(section.byteStart, section.byteEnd).toString('utf8');
          const refs = linkSection(section.id, sectionContent, this.db);
          // Clear old refs for this section and insert new ones
          this.db.run('DELETE FROM doc_code_refs WHERE section_id = ?', [section.id]);
          for (const ref of refs) {
            this.db.run(
              'INSERT OR REPLACE INTO doc_code_refs (section_id, qualified_name, ref_type, confidence) VALUES (?, ?, ?, ?)',
              [ref.sectionId, ref.qualifiedName, ref.refType, ref.confidence],
            );
            codeRefsCount++;
          }
        }
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    return { created, updated, removed: existingIds.size, codeRefs: codeRefsCount };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Scan the project for documentation files matching include/exclude patterns.
   */
  private scanDocFiles(): string[] {
    const includeMatchers = this.config.docsInclude.map(p => picomatch(p));
    const excludeMatchers = this.config.docsExclude.map(p => picomatch(p));
    const results: string[] = [];

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.projectRoot, full).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // Skip excluded directories early
          if (excludeMatchers.some(m => m(rel + '/'))) continue;
          walk(full);
        } else if (entry.isFile()) {
          // Check exclude first
          if (excludeMatchers.some(m => m(rel))) continue;
          // Check include
          if (includeMatchers.some(m => m(rel))) {
            results.push(rel);
          }
        }
      }
    };

    walk(this.projectRoot);
    return results;
  }

  /**
   * Flatten a parsed section tree into a flat array of DocSection objects.
   */
  private flattenSections(
    sections: ParsedSection[],
    filePath: string,
    fileHash: string,
  ): DocSection[] {
    const flat: DocSection[] = [];
    const now = Date.now();

    const walk = (nodes: ParsedSection[], parentId: string | null, ancestorSlugs: string[]) => {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const id = generateSectionId(filePath, ancestorSlugs, node.title, node.level);
        const contentHash = crypto.createHash('sha256').update(node.content).digest('hex');
        const summary = this.extractFirstSentence(node.content, node.title);

        // Store file hash in tags of root-level sections for incremental detection
        const tags: string[] = [];
        if (parentId === null && i === 0) {
          (tags as any)._fileHash = fileHash;
        }

        flat.push({
          id,
          filePath,
          title: node.title,
          level: node.level,
          parentId,
          summary,
          byteStart: node.byteStart,
          byteEnd: node.byteEnd,
          contentHash,
          tags: parentId === null && i === 0 ? [JSON.stringify({ _fileHash: fileHash })] : tags,
          position: i,
          updatedAt: now,
        });

        if (node.children.length > 0) {
          const currentSlug = slugify(node.title);
          walk(node.children, id, [...ancestorSlugs, currentSlug]);
        }
      }
    };

    walk(sections, null, []);
    return flat;
  }

  /**
   * Extract the first meaningful sentence from section content.
   * Skips the heading line itself.
   */
  private extractFirstSentence(content: string, title: string): string | null {
    // Remove the heading line
    const lines = content.split('\n');
    const bodyLines = lines.filter(l => {
      const trimmed = l.trim();
      // Skip heading lines, empty lines, and code fence markers
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('~~~')) return false;
      // Skip setext underlines
      if (/^[=-]+\s*$/.test(trimmed)) return false;
      return true;
    });

    if (bodyLines.length === 0) return null;

    // Take first non-empty line, truncate at sentence boundary
    const firstLine = bodyLines[0].trim();
    const sentenceEnd = firstLine.search(/[.!?]\s|[.!?]$/);
    if (sentenceEnd > 0) {
      return firstLine.slice(0, sentenceEnd + 1).trim();
    }

    // No sentence boundary — take the whole first line (truncated)
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
  }

  /**
   * Remove sections for files that no longer exist on disk.
   */
  private removeDeletedFiles(currentFiles: string[]): number {
    const currentSet = new Set(currentFiles);
    const indexedFiles = (this.db.all('SELECT DISTINCT file_path FROM doc_sections') as Array<{ file_path: string }>)
      .map(r => r.file_path);

    let removed = 0;
    for (const filePath of indexedFiles) {
      if (!currentSet.has(filePath)) {
        const count = this.db.get('SELECT COUNT(*) as cnt FROM doc_sections WHERE file_path = ?', [filePath])?.cnt ?? 0;
        this.db.run('DELETE FROM doc_sections WHERE file_path = ?', [filePath]);
        this.db.run('DELETE FROM doc_sections_fts WHERE id IN (SELECT id FROM doc_sections WHERE file_path = ?)', [filePath]);
        this.db.run('DELETE FROM doc_code_refs WHERE section_id IN (SELECT id FROM doc_sections WHERE file_path = ?)', [filePath]);
        removed += count;
      }
    }

    return removed;
  }
}
