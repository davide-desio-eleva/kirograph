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

