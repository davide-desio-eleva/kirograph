/**
 * File listing output filters (ls, find, tree)
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const filesFilter: CommandFilter = {
  name: 'files',

  matches(command: string): boolean {
    return /^\s*(ls|find|tree|dir)\b/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    if (/^\s*tree\b/.test(command)) return filterTree(rawOutput, level);
    if (/^\s*find\b/.test(command)) return filterFind(rawOutput, level);
    if (/^\s*ls\b/.test(command)) return filterLs(rawOutput, level);
    return { output: rawOutput, strategy: 'files:passthrough' };
  },
};

function filterLs(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  // Short ls output — don't compress
  if (lines.length <= 10) {
    return { output: raw, strategy: 'ls:short' };
  }

  // ls -la format: detect by permission string
  const isLongFormat = lines.some(l => /^[drwx-]{10}/.test(l));

  if (isLongFormat) {
    const dirs: string[] = [];
    const files: string[] = [];

    for (const line of lines) {
      if (line.startsWith('total')) continue;
      const parts = line.split(/\s+/);
      const name = parts[parts.length - 1];
      if (!name || name === '.' || name === '..') continue;

      if (line.startsWith('d')) {
        dirs.push(name + '/');
      } else {
        files.push(name);
      }
    }

    if (level === 'ultra') {
      return {
        output: `${dirs.length} dirs, ${files.length} files`,
        strategy: 'ls:ultra',
      };
    }

    if (level === 'aggressive') {
      const dirList = dirs.length > 0 ? `Dirs (${dirs.length}): ${dirs.slice(0, 10).join(', ')}${dirs.length > 10 ? '…' : ''}` : '';
      const fileList = files.length > 0 ? `Files (${files.length}): ${groupFilesByExt(files)}` : '';
      return { output: [dirList, fileList].filter(Boolean).join('\n'), strategy: 'ls:grouped' };
    }

    // Normal: show dirs + limited files
    const parts: string[] = [];
    if (dirs.length > 0) {
      parts.push(`Directories (${dirs.length}): ${dirs.join(', ')}`);
    }
    if (files.length > 0) {
      const maxFiles = 20;
      parts.push(`Files (${files.length}):`);
      parts.push(...files.slice(0, maxFiles).map(f => `  ${f}`));
      if (files.length > maxFiles) parts.push(`  …+${files.length - maxFiles} more`);
    }
    return { output: parts.join('\n'), strategy: 'ls:structured' };
  }

  // Simple ls (no -l): just truncate
  if (level === 'ultra') {
    return { output: `${lines.length} entries`, strategy: 'ls:count:ultra' };
  }

  const maxLines = level === 'aggressive' ? 20 : 40;
  if (lines.length <= maxLines) return { output: raw, strategy: 'ls:short' };

  const shown = lines.slice(0, maxLines).join('\n');
  return { output: `${shown}\n…+${lines.length - maxLines} more entries`, strategy: 'ls:truncated' };
}

function filterFind(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0) return { output: 'no matches', strategy: 'find:empty' };
  if (lines.length <= 10) return { output: raw, strategy: 'find:short' };

  // Group by directory
  const byDir = new Map<string, string[]>();
  for (const line of lines) {
    const dir = line.includes('/') ? line.slice(0, line.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(line.slice(line.lastIndexOf('/') + 1));
  }

  if (level === 'ultra') {
    const summary = [...byDir.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([d, f]) => `${d}/ (${f.length})`)
      .join(', ');
    return { output: `${lines.length} matches: ${summary}`, strategy: 'find:ultra' };
  }

  if (level === 'aggressive') {
    const grouped = [...byDir.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([dir, files]) => `${dir}/ (${files.length} files)`)
      .join('\n');
    const extra = byDir.size > 10 ? `\n…+${byDir.size - 10} more directories` : '';
    return { output: `${lines.length} matches in ${byDir.size} directories:\n${grouped}${extra}`, strategy: 'find:grouped' };
  }

  // Normal: show grouped with some file names
  const parts: string[] = [`${lines.length} matches in ${byDir.size} directories:\n`];
  let shown = 0;
  for (const [dir, files] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (shown >= 15) break;
    parts.push(`${dir}/ (${files.length}):`);
    for (const f of files.slice(0, 3)) parts.push(`  ${f}`);
    if (files.length > 3) parts.push(`  …+${files.length - 3} more`);
    shown++;
  }
  if (byDir.size > 15) parts.push(`\n…+${byDir.size - 15} more directories`);

  return { output: parts.join('\n'), strategy: 'find:structured' };
}

function filterTree(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length <= 20) return { output: raw, strategy: 'tree:short' };

  // Extract summary line (usually last: "X directories, Y files")
  const summaryLine = lines.find(l => /\d+\s+director/.test(l));

  if (level === 'ultra') {
    return { output: summaryLine || `${lines.length} lines`, strategy: 'tree:ultra' };
  }

  // Truncate to depth
  const maxLines = level === 'aggressive' ? 30 : 50;
  if (lines.length <= maxLines) return { output: raw, strategy: 'tree:short' };

  const shown = lines.slice(0, maxLines).join('\n');
  const summary = summaryLine ? `\n${summaryLine}` : `\n…+${lines.length - maxLines} more lines`;

  return { output: `${shown}${summary}`, strategy: 'tree:truncated' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupFilesByExt(files: string[]): string {
  const byExt = new Map<string, number>();
  for (const f of files) {
    const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '(no ext)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  return [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ');
}
