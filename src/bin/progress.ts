/**
 * KiroGraph CLI Progress Renderer
 *
 * Renders indexAll/sync progress events to stdout.
 * Lives in src/bin/ because it is a display concern — not part of the core library.
 */

import type { IndexProgress, SyncResult } from '../types';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const _v = '\x1b[38;5;99m';   // violet
const _r = '\x1b[0m';          // reset
const _d = '\x1b[2m';          // dim
const _g = '\x1b[38;5;114m';   // green

function _bar(pct: number, width = 20): string {
  const filled = Math.floor(pct / (100 / width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function _num(n: number): string {
  return n.toLocaleString();
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
    process.stdout.write(`\r  ${_v}parsing${_r}    [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(8)}`);
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
    if (p.current === -1) {
      // Large-codebase pre-flight warning emitted by VectorManager
      process.stdout.write(`\n  \x1b[33m⚠ Large codebase: ${_num(p.total)} embeddable symbols detected.\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  Embedding may be slow or memory-intensive. Consider setting enableEmbeddings: false\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  for codebases this large, or use a lighter model (e.g. Xenova/all-MiniLM-L6-v2).\x1b[0m\n\n`);
    } else {
      process.stdout.write(`\r  ${_v}embeddings${_r} [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(10)}`);
      if (p.current === p.total && p.total > 0) process.stdout.write('\n');
    }

  } else if (p.phase === 'docs') {
    if (p.meta?.msg) {
      process.stdout.write(`\r  ${_v}docs${_r}       ${_d}${p.meta.msg}${_r}${' '.repeat(20)}`);
      if (String(p.meta.msg).startsWith('docs:')) process.stdout.write('\n');
    }

  } else if (p.phase === 'data') {
    if (p.meta?.msg) {
      process.stdout.write(`\r  ${_v}data${_r}       ${_d}${p.meta.msg}${_r}${' '.repeat(20)}`);
      if (String(p.meta.msg).startsWith('data:')) process.stdout.write('\n');
    }

  } else {
    process.stdout.write(`\r  ${_v}${p.phase}${_r}  ${p.current}/${p.total}${' '.repeat(20)}`);
  }
}


// ── Sync Progress Renderer ────────────────────────────────────────────────────

/**
 * Renders a single sync progress event to stdout.
 * Same visual style as renderIndexProgress but tailored for incremental sync.
 */
export function renderSyncProgress(p: IndexProgress): void {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;

  if (p.phase === 'scanning') {
    if (p.current > 0) {
      process.stdout.write(`\r  ${_v}✓ scanning${_r}   ${_v}${_num(p.current)}${_r} ${_d}files found${_r}\n`);
    } else {
      process.stdout.write(`\r  ${_v}scanning${_r}    ${_d}detecting changes…${_r}${' '.repeat(20)}`);
    }

  } else if (p.phase === 'parsing') {
    process.stdout.write(`\r  ${_v}parsing${_r}    [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(8)}`);
    if (p.current === p.total) process.stdout.write('\n');

  } else if (p.phase === 'resolving') {
    if (p.current === 0 && p.total <= 1) {
      process.stdout.write(`\r  ${_v}resolving${_r}  cross-file references…${' '.repeat(20)}`);
    } else if (p.total > 0) {
      const bar = _bar(pct);
      const suffix = p.current === p.total
        ? `${_v}${_num(p.current)}${_r}${_d}/${_num(p.total)} refs${_r}\n`
        : `${_v}${_num(p.current)}${_r}${_d}/${_num(p.total)}${_r}${' '.repeat(10)}`;
      const prefix = p.current === p.total ? `\r  ${_v}✓ resolving${_r}` : `\r  ${_v}resolving${_r} `;
      process.stdout.write(`${prefix} [${bar}] ${suffix}`);
    }

  } else if (p.phase === 'embeddings') {
    if (p.current === -1) {
      process.stdout.write(`\n  \x1b[33m⚠ Large codebase: ${_num(p.total)} embeddable symbols detected.\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  Embedding may be slow or memory-intensive. Consider setting enableEmbeddings: false\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  for codebases this large, or use a lighter model (e.g. Xenova/all-MiniLM-L6-v2).\x1b[0m\n\n`);
    } else {
      process.stdout.write(`\r  ${_v}embeddings${_r} [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(10)}`);
      if (p.current === p.total && p.total > 0) process.stdout.write('\n');
    }

  } else if (p.phase === 'docs') {
    if (p.meta?.msg) {
      process.stdout.write(`\r  ${_v}docs${_r}       ${_d}${p.meta.msg}${_r}${' '.repeat(20)}`);
      if (String(p.meta.msg).startsWith('docs:')) process.stdout.write('\n');
    }

  } else if (p.phase === 'data') {
    if (p.meta?.msg) {
      process.stdout.write(`\r  ${_v}data${_r}       ${_d}${p.meta.msg}${_r}${' '.repeat(20)}`);
      if (String(p.meta.msg).startsWith('data:')) process.stdout.write('\n');
    }

  } else {
    process.stdout.write(`\r  ${_v}${p.phase}${_r}  ${p.current}/${p.total}${' '.repeat(20)}`);
  }
}

/**
 * Verbose sync progress renderer for `sync --progress`.
 * Prints each file as it is processed, errors inline, and a running count.
 * Exclude-cleanup removals are shown with a distinct prefix.
 */
export function renderSyncProgressVerbose(p: IndexProgress): void {
  if (p.phase === 'scanning') {
    if (p.meta?.excludeCleanup && p.meta.file) {
      // A file is being removed because it now matches an exclude pattern
      process.stdout.write(`  ${_d}exclude${_r}  ${_d}${p.meta.file}${_r}\n`);
    } else if (p.current > 0) {
      process.stdout.write(`  ${_v}✓ scanning${_r}   ${_v}${_num(p.current)}${_r} ${_d}files found${_r}\n`);
    } else {
      process.stdout.write(`  ${_v}scanning${_r}    ${_d}detecting changes…${_r}\n`);
    }

  } else if (p.phase === 'parsing') {
    if (p.currentFile) {
      const short = p.currentFile.length > 60
        ? '…' + p.currentFile.slice(p.currentFile.length - 59)
        : p.currentFile;
      process.stdout.write(`  ${_v}parse${_r}  ${_d}[${_num(p.current)}/${_num(p.total)}]${_r}  ${short}\n`);
    }

  } else if (p.phase === 'resolving') {
    if (p.current === 0 && p.total <= 1) {
      process.stdout.write(`  ${_v}resolving${_r}  cross-file references…\n`);
    } else if (p.total > 0 && p.current === p.total) {
      process.stdout.write(`  ${_v}✓ resolving${_r}  ${_v}${_num(p.current)}${_r}${_d}/${_num(p.total)} refs${_r}\n`);
    }

  } else if (p.phase === 'embeddings') {
    if (p.current === -1) {
      process.stdout.write(`\n  \x1b[33m⚠ Large codebase: ${_num(p.total)} embeddable symbols detected.\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  Embedding may be slow or memory-intensive. Consider setting enableEmbeddings: false\x1b[0m\n`);
      process.stdout.write(`  \x1b[33m  for codebases this large, or use a lighter model (e.g. Xenova/all-MiniLM-L6-v2).\x1b[0m\n\n`);
    } else {
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      process.stdout.write(`\r  ${_v}embeddings${_r} [${_bar(pct)}] ${_v}${pct}%${_r}${' '.repeat(10)}`);
      if (p.current === p.total && p.total > 0) process.stdout.write('\n');
    }

  } else if (p.phase === 'architecture') {
    if (p.meta?.msg) {
      process.stdout.write(`  ${_v}architecture${_r}  ${_d}${p.meta.msg}${_r}\n`);
    } else if (p.current === p.total && p.total > 0) {
      process.stdout.write(`  ${_v}✓ architecture${_r}\n`);
    }

  } else if (p.phase === 'docs') {
    if (p.meta?.msg) {
      process.stdout.write(`  ${_v}docs${_r}          ${_d}${p.meta.msg}${_r}\n`);
    }

  } else if (p.phase === 'data') {
    if (p.meta?.msg) {
      process.stdout.write(`  ${_v}data${_r}          ${_d}${p.meta.msg}${_r}\n`);
    }

  } else {
    process.stdout.write(`  ${_v}${p.phase}${_r}  ${p.current}/${p.total}\n`);
  }
}

/**
 * Renders the final sync summary with before/after counts.
 */
export function renderSyncSummary(result: SyncResult): void {
  const secs = (result.duration / 1000).toFixed(1);
  const filesChanged = result.added.length + result.modified.length;
  const filesDeleted = result.removed.length;

  console.log(`\n  ${_g}✓${_r} sync complete ${_d}(${secs}s)${_r}`);
  console.log(`    ${_d}files scanned:${_r}  ${_v}${_num(result.filesScanned)}${_r}`);
  console.log(`    ${_d}files changed:${_r}  ${_v}${_num(filesChanged)}${_r}`);
  console.log(`    ${_d}files deleted:${_r}  ${_v}${_num(filesDeleted)}${_r}`);
  console.log(`    ${_d}nodes added:${_r}    ${_v}${_num(result.nodesCreated)}${_r}`);
  console.log(`    ${_d}nodes updated:${_r}  ${_v}${_num(result.nodesUpdated)}${_r}`);
  console.log(`    ${_d}nodes removed:${_r}  ${_v}${_num(result.nodesRemoved)}${_r}`);
  console.log(`    ${_d}edges added:${_r}    ${_v}${_num(result.edgesCreated)}${_r}`);
  console.log(`    ${_d}edges removed:${_r}  ${_v}${_num(result.edgesRemoved)}${_r}`);
}
