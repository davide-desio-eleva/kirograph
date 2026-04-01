/**
 * KiroGraph CLI Progress Renderer
 *
 * Renders indexAll/sync progress events to stdout.
 * Lives in src/bin/ because it is a display concern — not part of the core library.
 */

import * as path from 'path';
import type { IndexProgress } from '../types';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const _v = '\x1b[38;5;99m';   // violet
const _r = '\x1b[0m';          // reset
const _d = '\x1b[2m';          // dim

function _bar(pct: number, width = 20): string {
  const filled = Math.floor(pct / (100 / width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Renders a single indexAll progress event to stdout.
 * Scanning and framework detection print a persistent line (with \n).
 * Parsing, resolving, and embeddings overwrite the current line (\r).
 */
export function renderIndexProgress(p: IndexProgress): void {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;

  if (p.phase === 'scanning') {
    process.stdout.write(`  ${_v}✓ scanning${_r}   ${_v}${p.current}${_r} ${_d}files found${_r}\n`);

  } else if (p.phase === 'parsing') {
    const file = p.currentFile ? path.basename(p.currentFile) : '';
    process.stdout.write(`\r  ${_v}parsing${_r}    [${_bar(pct)}] ${_v}${pct}%${_r}  ${_d}${file}${_r}${' '.repeat(8)}`);
    if (p.current === p.total) process.stdout.write('\n');

  } else if (p.phase === 'resolving') {
    if (p.current === 0 && p.total <= 1) {
      process.stdout.write(`\r  ${_v}resolving${_r}  cross-file references…${' '.repeat(20)}`);
    } else if (p.total > 0) {
      const bar = _bar(pct);
      const suffix = p.current === p.total
        ? `${_v}${p.current}${_r}${_d}/${p.total} refs${_r}\n`
        : `${_v}${p.current}${_r}${_d}/${p.total}${_r}${' '.repeat(10)}`;
      const prefix = p.current === p.total ? `\r  ${_v}✓ resolving${_r}` : `\r  ${_v}resolving${_r} `;
      process.stdout.write(`${prefix} [${bar}] ${suffix}`);
    }

  } else if (p.phase === 'detecting frameworks') {
    if (p.current === 1) {
      const frameworks = (p.meta?.frameworks as string[]) ?? [];
      const languages  = (p.meta?.languages  as string[]) ?? [];
      const fwLabel   = frameworks.length > 0 ? `${_v}${frameworks.join(', ')}${_r}` : `${_d}none${_r}`;
      const langLabel = languages.length > 0  ? `${_v}${languages.join(', ')}${_r}`  : `${_d}none${_r}`;
      process.stdout.write(`  ${_v}✓ languages${_r}  detected: ${langLabel}\n`);
      process.stdout.write(`  ${_v}✓ frameworks${_r} detected: ${fwLabel}\n`);
    }

  } else if (p.phase === 'embeddings') {
    process.stdout.write(`\r  ${_v}embeddings${_r} [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(10)}`);
    if (p.current === p.total && p.total > 0) process.stdout.write('\n');

  } else {
    process.stdout.write(`\r  ${_v}${p.phase}${_r}  ${p.current}/${p.total}${' '.repeat(20)}`);
  }
}
