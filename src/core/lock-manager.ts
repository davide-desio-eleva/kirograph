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
    if (fs.existsSync(this.lockPath)) {
      try {
        const content = fs.readFileSync(this.lockPath, 'utf8').trim();
        const [pidStr, tsStr] = content.split(':');
        const pid = parseInt(pidStr, 10);
        const ts = parseInt(tsStr, 10);

        if (!isNaN(pid) && pid !== process.pid) {
          const isStale = !isNaN(ts) && Date.now() - ts > LOCK_STALE_MS;
          if (!isStale) {
            try {
              process.kill(pid, 0);
              throw new Error(`KiroGraph is locked by PID ${pid}. Use 'kirograph unlock' to force-release.`);
            } catch (e: any) {
              if (e.message.includes('KiroGraph is locked')) throw e;
              // Process not found — stale lock, override it
            }
          }
        }
      } catch (e: any) {
        if (e.message.includes('KiroGraph is locked')) throw e;
        // Could not read lock file — override
      }
    }
    fs.writeFileSync(this.lockPath, `${process.pid}:${Date.now()}`);
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
      try { process.kill(pid, 0); return true; } catch { return false; }
    } catch { return false; }
  }
}
