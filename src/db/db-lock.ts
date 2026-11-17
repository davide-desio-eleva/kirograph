/**
 * The connection wrapper of the graph database, and what is left of the old lock recovery.
 *
 * Since 1.6.0 the database is opened with Node's own SQLite (`node:sqlite`, see sqlite.ts) in WAL
 * mode: SQLite locks the file the usual way, readers never wait for the writer, and a process
 * killed mid-write leaves a WAL that the next open replays by itself. The directory lock, writer
 * markers and journal replay that 1.5.x needed for the WASM driver are gone. What remains here:
 *
 * - `BusyRetryDatabase`, which reuses prepared statements, coalesces small writes into one
 *   transaction (see coalesce) and waits for a busy writer longer than SQLite's busy timeout;
 * - `liveDbWriters`, which finds KiroGraph 1.5.x processes still using the database (they keep a
 *   marker in `.kirograph/db-writers/`): the switch to WAL must not happen under them.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Database, Statement } from './sqlite';

const WRITERS_DIR = 'db-writers';

/** Tunables. Exposed mutable so tests can change them. */
export const dbLockTiming = {
  /** A 1.5.x marker older than this is not live even if its pid is: the process is idle. */
  markerFreshMs: 30_000,
  /** How long SQLite itself waits for a busy lock before reporting it (PRAGMA busy_timeout). */
  busyMs: 5_000,
  /** How long in all a statement waits for a lock held by another process before it fails. */
  maxWaitMs: 120_000,
};

/** Prepared statements kept per connection. Least recently used is dropped beyond this. */
const STATEMENT_CACHE_LIMIT = 256;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; } // EPERM: alive but owned by another user
}

/**
 * Pids of other processes of KiroGraph 1.5.x that have the database open: they refresh a marker
 * in `.kirograph/db-writers/<pid>` while they work. Markers of dead processes are removed.
 */
export function liveDbWriters(dbDir: string): number[] {
  const dir = path.join(dbDir, WRITERS_DIR);
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
 * Handle over the database. Statements are prepared once and reused, small writes can be
 * coalesced into one transaction, and a statement that meets a busy lock waits for it.
 */
export class BusyRetryDatabase {
  private readonly statements = new Map<string, Statement>();

  // Write coalescing (see coalesce())
  private coalescing = 0;
  private explicitTransaction = false;
  private implicitOpen = false;
  private flushTimer: ReturnType<typeof setImmediate> | null = null;

  constructor(private readonly raw: Database) {}

  /** The cached statement for `sql`, prepared on first use. */
  private statement(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) {
      // Move to the end: Map iteration order is the recency order
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    if (this.statements.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = this.statements.keys().next().value as string;
      this.statements.delete(oldest);
    }
    const stmt = this.raw.prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  run(sql: string, values?: unknown): unknown {
    this.beforeStatement(sql);
    const result = this.op(() => this.statement(sql).run(values as any));
    this.afterStatement(sql);
    return result;
  }
  exec(sql: string): unknown {
    this.beforeStatement(sql);
    const result = this.op(() => this.raw.exec(sql));
    this.afterStatement(sql);
    return result;
  }
  get(sql: string, values?: unknown): any { return this.op(() => this.statement(sql).get(values as any)); }
  all(sql: string, values?: unknown): any[] { return this.op(() => this.statement(sql).all(values as any)); }

  /**
   * Runs `fn` with write coalescing: the writes it makes outside a transaction share one that is
   * committed when the event loop next turns (that is, as soon as the code waits for I/O such as a
   * network call) and when `fn` ends. Without it every write is its own transaction, with a
   * commit each, so a phase that makes thousands of small writes took minutes.
   *
   * The transaction never spans a wait for I/O, so the write lock is not held while waiting on a
   * network, and nothing outside this process sees a half-written state. Explicit transactions
   * work as usual: a BEGIN commits the shared one first. Meant for code that makes many writes in
   * a row and does not need each one durable before the next.
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
    this.statements.clear();
    this.raw.close();
  }

  /** Kept for callers that mark a long transaction: SQLite's own locking needs nothing more. */
  hold(): () => void {
    return () => {};
  }

  /**
   * Runs one operation. SQLite waits `busyMs` for a busy lock by itself; past that, the statement
   * is tried again until `maxWaitMs`, so a long sync in another process is waited for. Inside a
   * transaction there is nothing to retry (the lock was taken by its first statement).
   */
  private op<T>(fn: () => T): T {
    if (this.explicitTransaction || this.implicitOpen) return fn();
    let deadline = 0;
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (!/database is locked|SQLITE_BUSY|database table is locked/i.test(String((err as Error)?.message ?? err))) throw err;
        deadline ||= Date.now() + dbLockTiming.maxWaitMs;
        if (Date.now() >= deadline) throw err;
      }
    }
  }
}
