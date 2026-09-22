/**
 * KiroGraph Wiki — Rename
 *
 * Renames a page's slug: moves its file on disk and rewrites every
 * `[[oldSlug]]` reference across the wiki (including the page's own
 * content, for hub pages that link to themselves) to `[[newSlug]]`.
 * The IWE-inspired "rename with automatic link updates" refactor, ported
 * to the CLI rather than an LSP rename action.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { WikiDatabase } from './database';
import { slugToFilePath, updateManifest } from './ingest';
import { extractLinks } from './links';

export interface RenamePageResult {
  from: string;
  to: string;
  /** Other pages whose [[from]] links were rewritten to [[to]]. */
  linksUpdated: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renamePage(
  wikiDir: string,
  wikiDb: WikiDatabase,
  fromSlug: string,
  toSlug: string,
): RenamePageResult {
  if (fromSlug === toSlug) {
    throw new Error('New slug is the same as the current slug');
  }

  const page = wikiDb.getPage(fromSlug);
  if (!page) {
    throw new Error(`Wiki page "${fromSlug}" not found`);
  }
  if (wikiDb.getPage(toSlug)) {
    throw new Error(`Wiki page "${toSlug}" already exists — pick a different slug or delete it first`);
  }

  const fromPath = path.join(wikiDir, slugToFilePath(fromSlug));
  const toPath = path.join(wikiDir, slugToFilePath(toSlug));
  if (!fs.existsSync(fromPath)) {
    throw new Error(`File for "${fromSlug}" not found on disk at ${fromPath} — run \`kirograph wiki reindex\` to resync`);
  }
  if (fs.existsSync(toPath)) {
    throw new Error(`Target file already exists at ${toPath}`);
  }

  // Move the file
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.renameSync(fromPath, toPath);
  removeIfEmpty(path.dirname(fromPath), wikiDir);

  // Reindex: drop the old slug, insert the new one under the moved path.
  wikiDb.deletePage(fromSlug);
  wikiDb.upsertPage({
    slug: toSlug,
    title: page.title,
    content: fs.readFileSync(toPath, 'utf8'),
    filePath: path.relative(wikiDir, toPath),
    sourceCount: page.sourceCount,
  });

  // Rewrite every [[fromSlug]] reference across the wiki — including the
  // renamed page's own content, in case it links to itself (hub pages).
  const linkRe = new RegExp(`\\[\\[\\s*${escapeRegExp(fromSlug)}\\s*\\]\\]`, 'g');
  const linksUpdated: string[] = [];

  for (const p of wikiDb.listPages()) {
    if (!extractLinks(p.content).includes(fromSlug)) continue;

    const absPath = path.join(wikiDir, slugToFilePath(p.slug));
    const current = fs.readFileSync(absPath, 'utf8');
    const rewritten = current.replace(linkRe, `[[${toSlug}]]`);
    if (rewritten === current) continue;

    fs.writeFileSync(absPath, rewritten, 'utf8');
    wikiDb.upsertPage({
      slug: p.slug,
      title: p.title,
      content: rewritten,
      filePath: p.filePath,
      sourceCount: 0,
    });
    if (p.slug !== toSlug) linksUpdated.push(p.slug);
  }

  updateManifest(wikiDir, wikiDb);

  return { from: fromSlug, to: toSlug, linksUpdated };
}

/** Best-effort cleanup of a now-empty directory left behind by a nested-slug move. Never removes wikiDir itself. */
function removeIfEmpty(dir: string, wikiDir: string): void {
  if (path.resolve(dir) === path.resolve(wikiDir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Not empty, doesn't exist, or a permissions issue — leave it.
  }
}
