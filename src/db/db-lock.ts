/**
 * Recovery and retry for the database lock that node-sqlite3-wasm takes.
 *
 * The WASM build locks the file by creating the directory `kirograph.db.lock` and removes it on
 * close. A process killed while it holds the lock (an IDE closing an MCP server or a hook, a
 * crash) never removes it, so every later open failed with "Database is locked" until someone
 * ran `kirograph unlock`. Two changes fix that:
 *
 * - Each process that is using the database leaves a marker in `.kirograph/db-writers/<pid>` for
 *   as long as it runs a statement or a transaction. A lock directory is stale when it is older
 *   than `dbLockTiming.staleAfterMs` and no other live process has a marker. Only then it is
 *   removed.
 * A live writer is waited for by the driver itself (`busy_timeout`), so only the stale case
 * needs handling here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';

const WRITERS_DIR = 'db-writers';

/** Tunables. Exposed mutable so tests can shorten the waits. */
export const dbLockTiming = {
  /** A lock directory older than this, with no live marker, is treated as left behind by a dead process. */
  staleAfterMs: 5_000,
  /** Total time a busy statement or an open waits for a live holder before giving up. */
  maxWaitMs: 8_000,
};

/** Sleep without the event loop, for the synchronous database API. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writersDir(dbDir: string): string {
  return path.join(dbDir, WRITERS_DIR);
}

/** Writes this process's marker. Returns the function that removes it. */
function markWriter(dbDir: string): () => void {
  const dir = writersDir(dbDir);
  const file = path.join(dir, String(process.pid));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; } // EPERM: alive but owned by another user
}

/** Pids of other live processes that are using the database. Markers of dead processes are removed. */
function liveOtherWriters(dbDir: string): number[] {
  const dir = writersDir(dbDir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const live: number[] = [];
  for (const name of names) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || pid === process.pid) continue;
    if (isAlive(pid)) {
      live.push(pid);
    } else {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
    }
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
 * Waits until the database lock is free, removing it if it is stale. Throws if a live process
 * keeps it for longer than `dbLockTiming.maxWaitMs`.
 */
export function waitForDbLock(dbDir: string, lockPath: string): void {
  const deadline = Date.now() + dbLockTiming.maxWaitMs;
  while (!clearStaleDbLock(dbDir, lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Database is locked by another process (${lockPath} exists).\n` +
        `Run: kirograph unlock\n` +
        `Or delete the lock manually: ${lockPath}`,
      );
    }
    sleepSync(50);
  }
}

/**
 * Handle over the raw WASM database. Every statement runs with this process marked as a writer.
 * `hold()` keeps the marker for the length of a transaction.
 */
export class BusyRetryDatabase {
  private depth = 0;

  constructor(
    private readonly raw: any,
    private readonly dbDir: string,
    private readonly lockPath: string,
  ) {}

  // Writes are marked; reads are not. A marker costs a file write and removal, which is most of
  // the overhead on read-heavy loops, and a stuck read lock is released once it is older than
  // `staleAfterMs`, which no short read reaches.
  run(...args: unknown[]): unknown { return this.op(() => this.raw.run(...args)); }
  exec(...args: unknown[]): unknown { return this.op(() => this.raw.exec(...args)); }
  get(...args: unknown[]): any { return this.raw.get(...args); }
  all(...args: unknown[]): any[] { return this.raw.all(...args); }

  close(): void { this.raw.close(); }

  /** Marks this process as a writer until the returned function runs. Used around transactions. */
  hold(): () => void {
    const release = this.depth === 0 ? markWriter(this.dbDir) : () => {};
    this.depth++;
    return () => {
      this.depth--;
      release();
    };
  }

  private op<T>(fn: () => T): T {
    const release = this.hold();
    try {
      return fn();
    } finally {
      release();
    }
  }
}
