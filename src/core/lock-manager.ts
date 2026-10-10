/**
 * LockManager — file-based process lock + dirty marker.
 *
 * The lock prevents concurrent indexing runs (even from separate processes).
 * The dirty marker is a lightweight signal written on file-save hooks and
 * consumed by sync-if-dirty to trigger deferred incremental syncs.
 */

import * as fs from 'fs';
import * as path from 'path';

const KIROGRAPH_DIR = '.kirograph';
const LOCK_FILE = 'kirograph.lock';
const DIRTY_FILE = 'dirty';
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

export class LockManager {
  private readonly lockPath: string;
  private readonly dirtyPath: string;

  constructor(private readonly projectRoot: string) {
    const dir = path.join(projectRoot, KIROGRAPH_DIR);
    this.lockPath = path.join(dir, LOCK_FILE);
    this.dirtyPath = path.join(dir, DIRTY_FILE);
  }

  // ── Process lock ───────────────────────────────────────────────────────────

  acquire(): void {
    // Atomic create with O_EXCL ('wx'): if the file already exists the open
    // fails with EEXIST instead of us doing a non-atomic existsSync→write, so
    // two processes starting together cannot both pass the check and both
    // write (which previously let two writers index the same DB concurrently).
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}:${Date.now()}`);
      fs.closeSync(fd);
      return;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // Lock file exists — only now inspect it for staleness.
    }

    // A lock file is present. Decide whether it is live (refuse) or stale (take
    // it over atomically via a temp file + rename, never a bare unlink+write).
    let takeOver = false;
    try {
      const content = fs.readFileSync(this.lockPath, 'utf8').trim();
      const [pidStr, tsStr] = content.split(':');
      const pid = parseInt(pidStr, 10);
      const ts = parseInt(tsStr, 10);

      if (isNaN(pid) || pid === process.pid) {
        takeOver = true; // our own or unparseable pid — safe to reclaim
      } else {
        const isStale = !isNaN(ts) && Date.now() - ts > LOCK_STALE_MS;
        if (isStale) {
          takeOver = true;
        } else {
          try {
            process.kill(pid, 0);
            // Process is alive — genuinely locked.
            throw new Error(`KiroGraph is locked by PID ${pid}. Use 'kirograph unlock' to force-release.`);
          } catch (e: any) {
            if (e.message.includes('KiroGraph is locked')) throw e;
            // EPERM means the process EXISTS but we may not signal it (a live
            // process owned by another user) — still locked, not stale. Only
            // ESRCH (no such process) means the holder is gone.
            if (e?.code === 'EPERM') {
              throw new Error(`KiroGraph is locked by PID ${pid}. Use 'kirograph unlock' to force-release.`);
            }
            takeOver = true; // ESRCH / process not found — stale
          }
        }
      }
    } catch (e: any) {
      if (e.message?.includes('KiroGraph is locked')) throw e;
      // A transient read error must NOT be treated as "free to override": the
      // lock demonstrably exists (EEXIST above). Refuse rather than stomp it.
      throw new Error(
        `KiroGraph lock file exists but could not be read (${e?.code ?? e?.message ?? 'unknown'}). ` +
        `Retry, or run 'kirograph unlock' if it is stale.`,
      );
    }

    if (takeOver) {
      // Overwrite atomically: write a temp file then rename over the lock, so a
      // concurrent reader never sees a half-written lock.
      const tmp = `${this.lockPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${process.pid}:${Date.now()}`);
      fs.renameSync(tmp, this.lockPath);
    }
  }

  release(): void {
    try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
  }

  forceRelease(): void {
    this.release();
  }

  // ── Dirty marker ───────────────────────────────────────────────────────────

  markDirty(): void {
    fs.writeFileSync(this.dirtyPath, String(Date.now()));
  }

  clearDirty(): void {
    try { fs.unlinkSync(this.dirtyPath); } catch { /* ignore */ }
  }

  isDirty(): boolean {
    return fs.existsSync(this.dirtyPath);
  }

  /** Returns true if a sync/index is currently running (lock file held by another process). */
  isLocked(): boolean {
    if (!fs.existsSync(this.lockPath)) return false;
    try {
      const content = fs.readFileSync(this.lockPath, 'utf8').trim();
      const [pidStr, tsStr] = content.split(':');
      const pid = parseInt(pidStr, 10);
      const ts = parseInt(tsStr, 10);
      if (isNaN(pid) || pid === process.pid) return false;
      const isStale = !isNaN(ts) && Date.now() - ts > LOCK_STALE_MS;
      if (isStale) return false;
      try { process.kill(pid, 0); return true; }
      catch (e: any) { return e?.code === 'EPERM'; } // EPERM = alive but not ours
    } catch { return false; }
  }
}
