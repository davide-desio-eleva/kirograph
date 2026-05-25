/**
 * Documentation Lint
 *
 * Health checks for the docs index:
 * 1. Broken code refs — qualified_names that no longer resolve to any node
 * 2. Stale sections — sections whose content_hash doesn't match the file on disk
 * 3. FTS desync — doc_sections_fts row count doesn't match doc_sections
 * 4. Orphan refs — doc_code_refs pointing to non-existent sections
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface LintResult {
  brokenRefs: Array<{ sectionId: string; qualifiedName: string }>;
  staleSections: Array<{ id: string; filePath: string }>;
  ftsDesync: { sections: number; ftsRows: number } | null;
  orphanRefs: number;
  totalIssues: number;
}

export function docsLint(db: any, projectRoot: string): LintResult {
  const result: LintResult = {
    brokenRefs: [],
    staleSections: [],
    ftsDesync: null,
    orphanRefs: 0,
    totalIssues: 0,
  };

  // 1. Broken code refs
  const refs = db.all(`
    SELECT r.section_id, r.qualified_name
    FROM doc_code_refs r
    LEFT JOIN nodes n ON n.qualified_name = r.qualified_name
    WHERE n.id IS NULL
  `) as Array<{ section_id: string; qualified_name: string }>;
  result.brokenRefs = refs.map(r => ({ sectionId: r.section_id, qualifiedName: r.qualified_name }));

  // 2. Stale sections (content hash mismatch)
  const sections = db.all(`
    SELECT id, file_path, byte_start, byte_end, content_hash
    FROM doc_sections
  `) as Array<{ id: string; file_path: string; byte_start: number; byte_end: number; content_hash: string }>;

  for (const section of sections) {
    const absPath = path.join(projectRoot, section.file_path);
    try {
      if (!fs.existsSync(absPath)) {
        result.staleSections.push({ id: section.id, filePath: section.file_path });
        continue;
      }
      const buffer = fs.readFileSync(absPath);
      const content = buffer.slice(section.byte_start, section.byte_end).toString('utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      if (hash !== section.content_hash) {
        result.staleSections.push({ id: section.id, filePath: section.file_path });
      }
    } catch {
      result.staleSections.push({ id: section.id, filePath: section.file_path });
    }
  }

  // 3. FTS desync
  const sectionCount = db.get('SELECT COUNT(*) as cnt FROM doc_sections')?.cnt ?? 0;
  const ftsCount = db.get('SELECT COUNT(*) as cnt FROM doc_sections_fts')?.cnt ?? 0;
  if (sectionCount !== ftsCount) {
    result.ftsDesync = { sections: sectionCount, ftsRows: ftsCount };
  }

  // 4. Orphan refs (pointing to non-existent sections)
  const orphans = db.get(`
    SELECT COUNT(*) as cnt
    FROM doc_code_refs r
    LEFT JOIN doc_sections s ON s.id = r.section_id
    WHERE s.id IS NULL
  `)?.cnt ?? 0;
  result.orphanRefs = orphans;

  result.totalIssues = result.brokenRefs.length + result.staleSections.length +
    (result.ftsDesync ? 1 : 0) + result.orphanRefs;

  return result;
}
