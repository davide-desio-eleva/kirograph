/**
 * KiroGraph Wiki — Ingest & apply-diff logic
 *
 * applyDiff: writes markdown files + updates SQLite from a parsed WIKI_DIFF
 * buildIngestPrompt: returns the prompt for the LLM (SCHEMA + MANIFEST + source)
 * resolveConflicts: deterministic auto-resolve by source date
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WikiDiff, WikiDiffEntry, WikiDiffConflict, WikiPage } from './types';
import type { WikiDatabase } from './database';

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugToFilePath(slug: string): string {
  return slug.replace(/\//g, path.sep) + '.md';
}

function ensureDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function upsertSection(content: string, section: string, newContent: string, mode: 'replace' | 'append'): string {
  const heading = `## ${section}`;
  const idx = content.indexOf(heading);

  if (idx === -1) {
    // Section doesn't exist — append at end
    return content.trimEnd() + `\n\n${heading}\n${newContent.trimEnd()}\n`;
  }

  // Find end of section (next ## heading or EOF)
  const afterHeading = idx + heading.length;
  const nextHeading = content.indexOf('\n## ', afterHeading);
  const sectionEnd = nextHeading === -1 ? content.length : nextHeading;

  if (mode === 'replace') {
    return content.slice(0, idx) + heading + '\n' + newContent.trimEnd() + '\n' + content.slice(sectionEnd);
  } else {
    // append: insert before next heading
    const sectionContent = content.slice(afterHeading, sectionEnd).trimEnd();
    return content.slice(0, idx) + heading + sectionContent + '\n' + newContent.trimEnd() + '\n' + content.slice(sectionEnd);
  }
}

// ── buildIngestPrompt ─────────────────────────────────────────────────────────

export function buildIngestPrompt(
  wikiDir: string,
  sourceContent: string,
  sourceName: string,
): string {
  const schemaPath = path.join(wikiDir, 'SCHEMA.md');
  const manifestPath = path.join(wikiDir, 'MANIFEST.md');

  const schema = fs.existsSync(schemaPath)
    ? fs.readFileSync(schemaPath, 'utf8')
    : '(no SCHEMA.md found — use default wiki page structure)';

  const manifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : '(wiki is empty — no pages yet)';

  return `You are maintaining a project wiki following the schema below.

## SCHEMA
${schema}

## MANIFEST (existing pages)
${manifest}

## SOURCE TO INGEST
Source name: ${sourceName}
${sourceContent}

## INSTRUCTIONS

Read the source above. Following the schema:
1. Identify entities, decisions, and patterns mentioned
2. For existing pages (listed in MANIFEST): update relevant sections
3. For new entities: create pages using the standard structure
4. Emit one WIKI_DIFF block per page operation
5. If incoming info contradicts existing content, emit a WIKI_DIFF_CONFLICTS block

Produce ONLY the WIKI_DIFF blocks and WIKI_DIFF_CONFLICTS blocks. No other output.`;
}

// ── applyDiff ─────────────────────────────────────────────────────────────────

export interface ApplyDiffResult {
  created: string[];
  updated: string[];
  conflictsResolved: string[];
  conflictsPending: WikiDiffConflict[];
}

export function applyDiff(
  diff: WikiDiff,
  wikiDir: string,
  wikiDb: WikiDatabase,
  opts: { autoResolveConflicts?: boolean } = {}
): ApplyDiffResult {
  const result: ApplyDiffResult = {
    created: [],
    updated: [],
    conflictsResolved: [],
    conflictsPending: [],
  };

  for (const entry of diff.entries) {
    if (!entry.page) continue;

    const relPath = slugToFilePath(entry.page);
    const absPath = path.join(wikiDir, relPath);

    if (entry.action === 'create') {
      ensureDir(absPath);
      const title = entry.title ?? entry.page;
      const fileContent = `# ${title}\n\n${entry.content.trimEnd()}\n`;
      fs.writeFileSync(absPath, fileContent, 'utf8');
      wikiDb.upsertPage({
        slug: entry.page,
        title,
        content: fileContent,
        filePath: relPath,
        sourceCount: 1,
      });
      result.created.push(entry.page);

    } else if (entry.action === 'upsert') {
      let current = '';
      let isNew = false;
      if (fs.existsSync(absPath)) {
        current = fs.readFileSync(absPath, 'utf8');
      } else {
        ensureDir(absPath);
        current = `# ${entry.page}\n\n`;
        isNew = true;
      }

      const updated = entry.section
        ? upsertSection(current, entry.section, entry.content, entry.mode ?? 'append')
        : current.trimEnd() + '\n\n' + entry.content.trimEnd() + '\n';

      fs.writeFileSync(absPath, updated, 'utf8');
      const titleMatch = updated.match(/^#\s+(.+)$/m);
      wikiDb.upsertPage({
        slug: entry.page,
        title: titleMatch?.[1] ?? entry.page,
        content: updated,
        filePath: relPath,
        sourceCount: 1,
      });
      if (isNew) {
        result.created.push(entry.page);
      } else {
        result.updated.push(entry.page);
      }

    } else if (entry.action === 'append') {
      let current = '';
      if (fs.existsSync(absPath)) {
        current = fs.readFileSync(absPath, 'utf8');
      } else {
        ensureDir(absPath);
        current = `# ${entry.page}\n\n`;
      }
      const appended = current.trimEnd() + '\n\n' + entry.content.trimEnd() + '\n';
      fs.writeFileSync(absPath, appended, 'utf8');
      const titleMatch = appended.match(/^#\s+(.+)$/m);
      wikiDb.upsertPage({
        slug: entry.page,
        title: titleMatch?.[1] ?? entry.page,
        content: appended,
        filePath: relPath,
        sourceCount: 1,
      });
      result.updated.push(entry.page);
    }
  }

  // Handle conflicts
  for (const conflict of diff.conflicts) {
    if (opts.autoResolveConflicts) {
      const resolved = resolveConflictByDate(conflict, wikiDir, wikiDb);
      if (resolved) {
        result.conflictsResolved.push(conflict.page);
        continue;
      }
    }
    result.conflictsPending.push(conflict);
  }

  updateManifest(wikiDir, wikiDb);

  return result;
}

// ── resolveConflictByDate ─────────────────────────────────────────────────────

function resolveConflictByDate(
  conflict: WikiDiffConflict,
  wikiDir: string,
  wikiDb: WikiDatabase,
): boolean {
  const existingDate = conflict.existingDate ? new Date(conflict.existingDate).getTime() : 0;
  const incomingDate = conflict.incomingDate ? new Date(conflict.incomingDate).getTime() : 0;

  // Incoming is newer — replace existing claim and add superseded note
  if (incomingDate >= existingDate && conflict.page && conflict.section) {
    const relPath = slugToFilePath(conflict.page);
    const absPath = path.join(wikiDir, relPath);
    if (!fs.existsSync(absPath)) return false;

    let content = fs.readFileSync(absPath, 'utf8');
    const supersededNote = `\n> ⚠ Superseded by ${conflict.source} on ${conflict.incomingDate ?? 'unknown date'}\n`;
    const oldClaim = conflict.existing;
    content = content.replace(oldClaim, conflict.incoming + supersededNote);
    fs.writeFileSync(absPath, content, 'utf8');

    const titleMatch = content.match(/^#\s+(.+)$/m);
    wikiDb.upsertPage({
      slug: conflict.page,
      title: titleMatch?.[1] ?? conflict.page,
      content,
      filePath: relPath,
      sourceCount: 0,
    });
    return true;
  }

  return false;
}

// ── updateManifest ────────────────────────────────────────────────────────────

export function updateManifest(wikiDir: string, wikiDb: WikiDatabase): void {
  const pages = wikiDb.listPages();
  if (pages.length === 0) return;

  const rows = pages
    .map(p => `| [${p.slug}](${p.filePath}) | ${p.title} | ${p.sourceCount} | ${new Date(p.updatedAt).toISOString().slice(0, 10)} |`)
    .join('\n');

  const manifest = `# Wiki Manifest\n\n| Slug | Title | Sources | Updated |\n|------|-------|---------|----------|\n${rows}\n`;
  fs.writeFileSync(path.join(wikiDir, 'MANIFEST.md'), manifest, 'utf8');
}

// ── reindex ───────────────────────────────────────────────────────────────────

export function reindexFromDisk(wikiDir: string, wikiDb: WikiDatabase): number {
  wikiDb.clearAll();

  let count = 0;

  function walkDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(abs);
      } else if (entry.name.endsWith('.md') && entry.name !== 'SCHEMA.md' && entry.name !== 'MANIFEST.md') {
        const rel = path.relative(wikiDir, abs);
        const slug = rel.replace(/\.md$/, '').replace(/\\/g, '/');
        const content = fs.readFileSync(abs, 'utf8');
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const stat = fs.statSync(abs);
        wikiDb.upsertPage({
          slug,
          title: titleMatch?.[1] ?? slug,
          content,
          filePath: rel,
          updatedAt: stat.mtimeMs,
          sourceCount: 0,
        });
        count++;
      }
    }
  }

  walkDir(wikiDir);
  updateManifest(wikiDir, wikiDb);
  return count;
}
