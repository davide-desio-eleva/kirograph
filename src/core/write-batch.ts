/**
 * Groups the per-file database writes of an index or sync into a few transactions.
 *
 * One transaction per file costs a commit each: an fsync plus a lock round trip, which was more
 * than half of a sync's time. Writing a batch of files in one transaction removes most of that. A
 * batch is bounded by file count and by row count, so the write lock is held only for a few
 * hundred milliseconds, and each file is written inside a savepoint, so one file that fails does
 * not undo the others.
 */

import type { GraphDatabase } from '../db/database';

/** Flush after this many files. */
const MAX_FILES = 20;
/** Flush after this many rows (nodes, edges and references), which bounds how long the lock is held. */
const MAX_ROWS = 3_000;

interface PendingWrite {
  write: () => void;
  onError: (err: unknown) => void;
}

export class WriteBatch {
  private pending: PendingWrite[] = [];
  private rows = 0;

  constructor(
    private readonly db: GraphDatabase,
    private readonly maxFiles: number = MAX_FILES,
    private readonly maxRows: number = MAX_ROWS,
  ) {}

  /**
   * Queues the writes of one file. `write` runs later inside a transaction; if it throws, only its
   * own changes are undone and `onError` is called. `rows` is its size, used to bound a batch.
   */
  add(write: () => void, onError: (err: unknown) => void, rows: number): void {
    this.pending.push({ write, onError });
    this.rows += rows;
    if (this.pending.length >= this.maxFiles || this.rows >= this.maxRows) this.flush();
  }

  /** Writes everything queued, in one transaction. Call before anything reads the database. */
  flush(): void {
    if (this.pending.length === 0) return;
    const items = this.pending;
    this.pending = [];
    this.rows = 0;
    this.db.transaction(() => {
      for (const item of items) {
        try {
          this.db.savepoint(item.write);
        } catch (err) {
          item.onError(err);
        }
      }
    });
  }
}
