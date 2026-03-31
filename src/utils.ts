/**
 * KiroGraph Utility Module
 *
 * Shared utilities: concurrency, batching, rate limiting, memory monitoring,
 * security path validation, and misc helpers.
 */

import * as path from 'path';
import * as fs from 'fs';
import { logWarn } from './errors';

// ── Mutex ─────────────────────────────────────────────────────────────────────

export class Mutex {
  private queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (!this._locked) {
          this._locked = true;
          resolve(() => this._release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(): boolean {
    return this._locked;
  }

  private _release(): void {
    this._locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── FileLock ──────────────────────────────────────────────────────────────────

export class FileLock {
  static readonly STALE_TIMEOUT_MS = 120_000; // 2 minutes

  constructor(private readonly lockPath: string) {}

  async acquire(): Promise<() => void> {
    const deadline = Date.now() + FileLock.STALE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        // Atomic create: fails if file already exists
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => this._release();
      } catch {
        // Check for stale lock
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > FileLock.STALE_TIMEOUT_MS) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          // Lock file disappeared between attempts — retry
          continue;
        }
        // Wait a bit before retrying
        await new Promise(r => setTimeout(r, 50));
      }
    }
    throw new Error(`FileLock: timed out waiting for lock at ${this.lockPath}`);
  }

  withLock<T>(fn: () => T): T {
    const fd = fs.openSync(this.lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    try {
      return fn();
    } finally {
      this._release();
    }
  }

  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private _release(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Already removed — ignore
    }
  }
}

// ── processInBatches ──────────────────────────────────────────────────────────

export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await fn(batch);
    results.push(...batchResults);
  }
  return results;
}

// ── debounce ──────────────────────────────────────────────────────────────────

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, delayMs: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (this: unknown, ...args: unknown[]) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delayMs);
  } as T;
}

// ── throttle ──────────────────────────────────────────────────────────────────

export function throttle<T extends (...args: unknown[]) => unknown>(fn: T, intervalMs: number): T {
  let lastCall = 0;
  return function (this: unknown, ...args: unknown[]) {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      return fn.apply(this, args);
    }
  } as T;
}

// ── MemoryMonitor ─────────────────────────────────────────────────────────────

export class MemoryMonitor {
  private readonly thresholdBytes: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private peakBytes = 0;

  constructor(opts: { thresholdMb: number; intervalMs: number }) {
    this.thresholdBytes = opts.thresholdMb * 1024 * 1024;
    this.intervalMs = opts.intervalMs;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      const used = process.memoryUsage().heapUsed;
      if (used > this.peakBytes) this.peakBytes = used;
      if (used > this.thresholdBytes) {
        logWarn(`MemoryMonitor: heap usage ${(used / 1024 / 1024).toFixed(1)} MB exceeds threshold ${(this.thresholdBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    }, this.intervalMs);
    // Allow the process to exit even if the monitor is running
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns peak heap usage in bytes. */
  getPeakUsage(): number {
    return this.peakBytes;
  }
}

// ── Security utils (moved from src/index.ts) ─────────────────────────────────

/** Resolve and validate that filePath is within root. Returns null if not. */
export function validatePathWithinRoot(filePath: string, root: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) return null;
  return resolved;
}

/** Throw if the given path is a sensitive system directory. */
export function validateProjectPath(projectRoot: string): void {
  const SENSITIVE_DIRS = new Set(['/', '/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/boot']);
  const resolved = path.resolve(projectRoot);
  if (SENSITIVE_DIRS.has(resolved)) {
    throw new Error(`Refusing to initialize KiroGraph in sensitive directory: ${resolved}`);
  }
}

/** Returns true if filePath is within root (string-based, no symlink resolution). */
export function isPathWithinRoot(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/** Returns true if filePath is within root, resolving symlinks (symlink-safe). */
export function isPathWithinRootReal(filePath: string, root: string): boolean {
  try {
    const real = fs.realpathSync(filePath);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizePath(p: string): string {
  return p.split(path.sep).join('/');
}

export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// ── CLI Progress Renderer ─────────────────────────────────────────────────────

const _v = '\x1b[38;5;99m';   // violet
const _r = '\x1b[0m';          // reset
const _d = '\x1b[2m';          // dim

function _bar(pct: number, width = 20): string {
  const filled = Math.floor(pct / (100 / width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  currentFile?: string;
  meta?: Record<string, unknown>;
}

/**
 * Renders a single indexAll progress event to stdout.
 * Scanning and framework detection print a persistent line (with \n).
 * Parsing, resolving, and embeddings overwrite the current line (\r).
 */
export function renderIndexProgress(p: IndexProgress): void {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;

  if (p.phase === 'scanning') {
    // Print once when scanning completes — persistent line
    process.stdout.write(`  ${_v}✓ scanning${_r}   ${_v}${p.current}${_r} ${_d}files found${_r}\n`);

  } else if (p.phase === 'parsing') {
    const file = p.currentFile ? path.basename(p.currentFile) : '';
    process.stdout.write(`\r  ${_v}parsing${_r}    [${_bar(pct)}] ${_v}${pct}%${_r}  ${_d}${file}${_r}${' '.repeat(8)}`);
    if (p.current === p.total) process.stdout.write('\n');

  } else if (p.phase === 'resolving') {
    if (p.current === 0 && p.total <= 1) {
      // Start — show spinner line before we know the total
      process.stdout.write(`\r  ${_v}resolving${_r}  cross-file references…${' '.repeat(20)}`);
    } else if (p.total > 0) {
      // In-progress or done — show bar
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
      const fwLabel = frameworks.length > 0 ? `${_v}${frameworks.join(', ')}${_r}` : `${_d}none${_r}`;
      const langLabel = languages.length > 0 ? `${_v}${languages.join(', ')}${_r}` : `${_d}none${_r}`;
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
