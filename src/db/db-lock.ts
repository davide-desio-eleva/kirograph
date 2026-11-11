/**
 * Recovery for the database lock that node-sqlite3-wasm takes.
 *
 * The WASM build locks the file by creating the directory `kirograph.db.lock` and removes it on
 * close. A process killed while it holds the lock (an IDE closing an MCP server or a hook, a
 * crash) never removes it, so every later open failed with "Database is locked" until someone
 * ran `kirograph unlock`.
 *
 * A process that uses the database keeps a marker in `.kirograph/db-writers/<pid>`. The marker is
 * refreshed at most once per `dbLockTiming.markerTouchMs` while the process works, and removed on
 * close. A lock directory older than `dbLockTiming.staleAfterMs` is stale when no other process
 * has a live marker: its pid is alive and the marker was refreshed within `markerFreshMs`. So an
 * idle process does not keep a dead writer's lock in place, and a dead process's marker is ignored.
 *
 * A live writer is waited for by the driver itself (`busy_timeout`), so nothing here waits.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';

const WRITERS_DIR = 'db-writers';

/** Tunables. Exposed mutable so tests can change them. */
export const dbLockTiming = {
  /** A lock directory older than this, with no live marker, is treated as left behind by a dead process. */
  staleAfterMs: 5_000,
  /** A marker older than this is not live even if its pid is: the process is idle. */
  markerFreshMs: 30_000,
  /** Minimum interval between two refreshes of this process's marker. */
  markerTouchMs: 1_000,
};

/** Prepared statements kept per connection. Least recently used is finalized beyond this. */
const STATEMENT_CACHE_LIMIT = 256;

function writersDir(dbDir: string): string {
  return path.join(dbDir, WRITERS_DIR);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; } // EPERM: alive but owned by another user
}

/** Pids of other processes that hold a live marker. Markers of dead processes are removed. */
function liveOtherWriters(dbDir: string): number[] {
  const dir = writersDir(dbDir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const live: number[] = [];
  for (const name of names) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || pid === process.pid) continue;
    const file = path.join(dir, name);
    if (!isAlive(pid)) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      continue;
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < dbLockTiming.markerFreshMs) live.push(pid);
    } catch { /* removed meanwhile */ }
  }
  return live;
}

/**
 * Removes the lock directory if no live process holds it. Returns true when the lock is free
 * (absent or just removed), false when a live holder still has it.
 */
export function clearStaleDbLock(dbDir: string, lockPath: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(lockPath); }
  catch { return true; } // gone already
  if (Date.now() - stat.mtimeMs < dbLockTiming.staleAfterMs) return false;
  const live = liveOtherWriters(dbDir);
  if (live.length > 0) return false;
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    return false;
  }
  logWarn(`Removed a stale database lock left by a process that exited (${lockPath}).`);
  return true;
}

/**
 * Handle over the raw WASM database. Every operation refreshes this process's writer marker, and
 * statements are prepared once and reused.
 */
export class BusyRetryDatabase {
  /**
   * The WASM driver prepares and finalizes a statement on every `get`, `all` and `run`. Keeping
   * the prepared statement and binding new values to it skips that work, which dominates the cost
   * of the many small queries an index makes.
   */
  private readonly statements = new Map<string, any>();
  private markerFile: string | undefined;
  private lastTouch = 0;

  constructor(
    private readonly raw: any,
    private readonly dbDir: string,
    private readonly lockPath: string,
  ) {}

  /** The cached statement for `sql`, prepared on first use. */
  private statement(sql: string): any {
    const cached = this.statements.get(sql);
    if (cached) {
      // Move to the end: Map iteration order is the recency order
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    if (this.statements.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = this.statements.keys().next().value as string;
      this.finalizeQuietly(this.statements.get(oldest));
      this.statements.delete(oldest);
    }
    const stmt = this.raw.prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  private finalizeQuietly(stmt: any): void {
    try { stmt?.finalize(); } catch { /* already finalized */ }
  }

  /**
   * Refreshes this process's marker, at most once per `markerTouchMs`. Creating it again also
   * covers a marker removed by hand.
   */
  private touchMarker(): void {
    const now = Date.now();
    if (this.markerFile && now - this.lastTouch < dbLockTiming.markerTouchMs) return;
    const dir = writersDir(this.dbDir);
    this.markerFile ??= path.join(dir, String(process.pid));
    try {
      fs.utimesSync(this.markerFile, now / 1000, now / 1000);
    } catch {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.markerFile, String(now));
    }
    this.lastTouch = now;
  }

  // Writes and reads both refresh the marker: the driver takes the directory lock for reads too,
  // so a process killed during a read can leave it behind.
  run(sql: string, values?: unknown): unknown { return this.op(() => this.reusing(sql, stmt => stmt.run(values))); }
  exec(...args: unknown[]): unknown { return this.op(() => this.raw.exec(...args)); }
  get(sql: string, values?: unknown): any { return this.op(() => this.reusing(sql, stmt => stmt.get(values))); }
  all(sql: string, values?: unknown): any[] { return this.op(() => this.reusing(sql, stmt => stmt.all(values))); }

  /**
   * Runs a cached statement and resets it afterwards. A reset is required: `get` stops after the
   * first row and leaves the statement stepping, which keeps a read lock open until the next use.
   * With the directory lock of the WASM build, that lock blocks every writer.
   *
   * The driver has no public reset, only `_reset()`. The driver is pinned in package.json, so
   * this is safe here; check it again on any upgrade.
   */
  private reusing<T>(sql: string, fn: (stmt: any) => T): T {
    const stmt = this.statement(sql);
    try {
      return fn(stmt);
    } finally {
      stmt._reset();
    }
  }

  close(): void {
    for (const stmt of this.statements.values()) this.finalizeQuietly(stmt);
    this.statements.clear();
    this.raw.close();
    if (this.markerFile) {
      try { fs.unlinkSync(this.markerFile); } catch { /* already gone */ }
      this.markerFile = undefined;
    }
  }

  /**
   * Marks this process as active for a transaction. The marker stays fresh while the transaction
   * runs (every operation refreshes it), so the release function has nothing to undo.
   */
  hold(): () => void {
    this.touchMarker();
    return () => {};
  }

  private op<T>(fn: () => T): T {
    this.touchMarker();
    return fn();
  }
}
