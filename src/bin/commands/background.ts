/**
 * Starts `kirograph sync` as a separate process and returns at once.
 *
 * A hook that runs a sync in the foreground can be killed by the tool that runs it (Kiro stops a
 * shell hook after 60 seconds), and a sync killed halfway leaves the database to be recovered.
 * Started this way the sync belongs to no one: it carries on after the hook has returned or been
 * stopped. If another sync is already running there is nothing to start.
 */

import { spawn } from 'child_process';
import { LockManager } from '../../core/lock-manager';

/** Returns true when a sync was started, false when one was already running. */
export function startBackgroundSync(projectRoot: string): boolean {
  if (new LockManager(projectRoot).isLocked()) return false;
  const child = spawn(process.execPath, [process.argv[1], 'sync', '--quiet', projectRoot], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return true;
}
