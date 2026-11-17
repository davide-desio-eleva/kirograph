/**
 * Tells the agent when a file a tool response names has changed since the graph last read it.
 *
 * Between an edit and the next sync, a tool answers from the old graph. The response would be
 * silently wrong for that file, so it starts with a notice naming it and asking the agent to read
 * the file itself. Only the files the response names are checked: one stat each, compared with the
 * stat key the index recorded when it read the file (FileRecord.statKey).
 */

import * as fs from 'fs';
import * as path from 'path';
import { statKey } from '../sync/stat-key';

interface IndexedFile {
  statKey: string | null;
  indexedAt: number;
}

/** Path-like tokens of a response: `src/a.ts`, `lib/x/y.py:12`, `./b.go`. */
const PATH_TOKEN = /(?:\.{0,2}\/)?[\w@.\-]+(?:\/[\w@.\-]+)*\.\w{1,10}/g;

/** Tools whose output is not read from the graph: nothing of theirs can be stale. */
export const NO_STALENESS_CHECK = new Set([
  'kirograph_exec', 'kirograph_gain', 'kirograph_read', 'kirograph_retrieve', 'kirograph_compress',
  'kirograph_budget', 'kirograph_status',
]);

/**
 * The files named in `text` that changed or were deleted after they were indexed.
 * `files` maps each indexed path (relative, forward slashes) to what the index recorded.
 */
export function staleFiles(text: string, projectRoot: string, files: Map<string, IndexedFile>): { changed: string[]; deleted: string[] } {
  const named = new Set<string>();
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const rel = token.replace(/^\.\//, '');
    if (files.has(rel)) named.add(rel);
  }
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const rel of named) {
    const known = files.get(rel)!;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(projectRoot, rel));
    } catch {
      deleted.push(rel);
      continue;
    }
    // Without a recorded key (an index made before keys were recorded), the mtime decides
    const stale = known.statKey ? statKey(st) !== known.statKey : st.mtimeMs > known.indexedAt;
    if (stale) changed.push(rel);
  }
  return { changed: changed.sort(), deleted: deleted.sort() };
}

/** The notice to put before a response, or '' when nothing it names is stale. */
export function stalenessNotice(stale: { changed: string[]; deleted: string[] }): string {
  const lines: string[] = [];
  const list = (files: string[]) => files.slice(0, 10).map(f => `\`${f}\``).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');
  if (stale.changed.length > 0) {
    lines.push(`⚠️ Changed since the graph last read ${stale.changed.length === 1 ? 'it' : 'them'}: ${list(stale.changed)}. `
      + 'What this response says about these files may be out of date: read them directly for their current content.');
  }
  if (stale.deleted.length > 0) {
    lines.push(`⚠️ Deleted since the graph last read ${stale.deleted.length === 1 ? 'it' : 'them'}: ${list(stale.deleted)}.`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
