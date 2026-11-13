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
  /**
   * How long SQLite itself waits for a lock before reporting it busy. After each such wait a lock
   * left by a process that died is looked for, so a long-running process (an MCP server) recovers
   * from one that appeared after it opened the database.
   */
  busyMs: 5_000,
  /**
   * The age at which a lock found while running (not at open) is taken for a dead process's. Much
   * longer than `staleAfterMs`: a writer from an older KiroGraph leaves no marker, so a live one
   * looks dead, and its lock must not be taken from under it.
   */
  runtimeStaleAfterMs: 60_000,
  /** How long in all a statement waits for a lock held by a live process before it fails. */
  maxWaitMs: 120_000,
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

/** Pids of other live processes that have the database open (they hold a fresh writer marker). */
export function liveDbWriters(dbDir: string): number[] {
  return liveOtherWriters(dbDir);
}

/**
 * Removes the lock directory if no live process holds it. Returns true when the lock is free
 * (absent or just removed), false when a live holder still has it.
 */
export function clearStaleDbLock(dbDir: string, lockPath: string, staleAfterMs = dbLockTiming.staleAfterMs): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(lockPath); }
  catch { return true; } // gone already
  if (Date.now() - stat.mtimeMs < staleAfterMs) return false;
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

  // Write coalescing (see coalesce())
  private coalescing = 0;
  private explicitTransaction = false;
  private implicitOpen = false;
  private flushTimer: ReturnType<typeof setImmediate> | null = null;

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
  run(sql: string, values?: unknown): unknown {
    this.beforeStatement(sql);
    const result = this.op(() => this.reusing(sql, stmt => stmt.run(values)));
    this.afterStatement(sql);
    return result;
  }
  exec(...args: unknown[]): unknown {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    this.beforeStatement(sql);
    const result = this.op(() => this.raw.exec(...args));
    this.afterStatement(sql);
    return result;
  }
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

  /**
   * Runs `fn` with write coalescing: the writes it makes outside a transaction share one that is
   * committed when the event loop next turns (that is, as soon as the code waits for I/O such as a
   * network call) and when `fn` ends. Without it every write is its own transaction, and each
   * commit costs about 10 ms (a journal file created, synced and deleted), so a phase that makes
   * thousands of small writes took minutes.
   *
   * The transaction never spans a wait for I/O, so the database lock is not held while waiting
   * on a network, and nothing outside this process sees a half-written state. Explicit
   * transactions work as usual: a BEGIN commits the shared one first. Meant for code that makes
   * many writes in a row and does not need each one durable before the next.
   */
  async coalesce<T>(fn: () => Promise<T>): Promise<T> {
    this.coalescing++;
    try {
      return await fn();
    } finally {
      if (--this.coalescing === 0) this.flushCoalesced();
    }
  }

  private flushCoalesced(): void {
    if (this.flushTimer) { clearImmediate(this.flushTimer); this.flushTimer = null; }
    if (!this.implicitOpen) return;
    this.implicitOpen = false;
    this.raw.exec('COMMIT');
  }

  private beforeStatement(sql: string): void {
    if (/^\s*BEGIN\b/i.test(sql) || /^\s*(PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
      this.flushCoalesced(); // these cannot run inside the shared transaction, or must start their own
      return;
    }
    if (this.coalescing > 0 && !this.explicitTransaction && !this.implicitOpen
        && /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) {
      this.touchMarker();
      this.raw.exec('BEGIN');
      this.implicitOpen = true;
      this.flushTimer = setImmediate(() => { this.flushTimer = null; this.flushCoalesced(); });
    }
  }

  private afterStatement(sql: string): void {
    if (/^\s*BEGIN\b/i.test(sql)) this.explicitTransaction = true;
    else if (/^\s*(COMMIT|END)\b/i.test(sql) || (/^\s*ROLLBACK\b/i.test(sql) && !/^\s*ROLLBACK\s+TO\b/i.test(sql))) {
      this.explicitTransaction = false;
    }
  }

  close(): void {
    this.flushCoalesced();
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

  /**
   * Runs one operation. A lock that is busy is waited for, and every `busyMs` a lock left behind by
   * a process that died is cleared: before, only the open looked, and a server that met one later
   * waited the full two minutes and failed. Inside a transaction there is nothing to retry (the
   * lock was taken by its first statement), so this applies to statements on their own.
   */
  private op<T>(fn: () => T): T {
    this.touchMarker();
    if (this.explicitTransaction || this.implicitOpen) return fn();
    let deadline = 0;
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (!/database is locked|SQLITE_BUSY/i.test(String((err as Error)?.message ?? err))) throw err;
        deadline ||= Date.now() + dbLockTiming.maxWaitMs;
        if (Date.now() >= deadline) throw err;
        if (clearStaleDbLock(this.dbDir, this.lockPath, dbLockTiming.runtimeStaleAfterMs) && this.hotJournalPresent()) {
          // The writer died mid-transaction. Its journal has to be replayed before the file is used,
          // and this connection already has the file open, so it cannot be done from here.
          throw new Error(
            'The database was left half written by a process that was killed. Restart KiroGraph ' +
            '(close the IDE or the MCP server and open it again): it rolls the journal back when it opens the database.');
        }
      }
    }
  }

  private hotJournalPresent(): boolean {
    try { return fs.statSync(path.join(this.dbDir, 'kirograph.db-journal')).size > 0; } catch { return false; }
  }
}
