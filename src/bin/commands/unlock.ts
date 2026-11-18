import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { dim, reset, green } from '../ui';
import { LockManager } from '../../core/lock-manager';
import { liveDbWriters } from '../../db/db-lock';

// Amber for the "a sync is still running" warning. ui.ts only exports
// green/dim/reset, so the one warning colour this command needs is inlined
// rather than widening the shared palette.
const yellow = '\x1b[38;5;179m';

export function register(program: Command): void {
  program
    .command('unlock [projectPath]')
    .description('Force-release a stale KiroGraph process lock (and the database lock left by KiroGraph 1.5 or older)')
    .option('--force', 'Release the locks even if a KiroGraph 1.5 process seems to have the database open')
    .action(async (projectPath: string | undefined, opts: { force?: boolean }) => {
      const root = path.resolve(projectPath ?? process.cwd());
      const dir = path.join(root, '.kirograph');
      const processLockPath = path.join(dir, 'kirograph.lock');
      const dbLockPath = path.join(dir, 'kirograph.db.lock');

      // If a live indexer still holds the process lock, a sync/index is
      // genuinely running: releasing either lock would corrupt it. Captured
      // before touching anything, and short-circuits the whole command.
      if (new LockManager(root).isLocked()) {
        console.log(
          `  ${yellow}!${reset} A sync/index is currently running — locks left in place. ${dim}` +
          `Wait for it to finish, or stop that process, then re-run unlock.${reset}`
        );
        return;
      }

      // A KiroGraph 1.5 process that has the database open keeps a marker in db-writers/. Taking
      // its lock from under it could corrupt a write in progress. (1.6 and later lock the file with
      // SQLite itself, which leaves nothing behind when a process dies.)
      const holders = liveDbWriters(dir);
      if (holders.length > 0 && !opts.force) {
        console.log(
          `  ${yellow}!${reset} KiroGraph is running (pid ${holders.join(', ')}) and has the database open — locks left in place. ${dim}` +
          `Stop it (close the IDE or the MCP server), or run unlock --force if you are sure it is stuck.${reset}`
        );
        return;
      }

      let released = 0;

      // ── Process lock (kirograph.lock) ──────────────────────────────────────
      // The pid:timestamp lock written by LockManager. Removing it is the
      // original behaviour of this command.
      if (fs.existsSync(processLockPath)) {
        let content = '';
        try { content = fs.readFileSync(processLockPath, 'utf8').trim(); } catch { /* ignore */ }
        fs.unlinkSync(processLockPath);
        console.log(`  ${green}✓${reset} Process lock released ${dim}(was held by: ${content || 'unknown'})${reset}`);
        released++;
      }

      // ── Database lock of KiroGraph 1.5 or older (kirograph.db.lock) ─────────
      // The WASM driver of 1.5 and older locked by creating this directory, and a killed process
      // left it behind. 1.6 removes it when it first opens the database; this is for a project
      // still used by an older version.
      if (fs.existsSync(dbLockPath)) {
        // Directory in current versions; tolerate a plain file from older ones.
        fs.rmSync(dbLockPath, { recursive: true, force: true });
        console.log(`  ${green}✓${reset} Database lock released ${dim}(${dbLockPath})${reset}`);
        released++;
      }

      if (released === 0) {
        console.log(`  ${dim}No lock file found.${reset}`);
      }
    });
}
