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
    .description('Force-release stale KiroGraph locks (process lock and database lock)')
    .option('--force', 'Release the locks even if another KiroGraph process (such as an MCP server) has the database open')
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

      // An MCP server or another command that has the database open keeps a marker in
      // db-writers/. Taking the lock from under it could corrupt a write in progress.
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

      // ── Database lock (kirograph.db.lock) ──────────────────────────────────
      // This is the lock the "Database is locked" error actually points at, and
      // the one `unlock` historically did NOT clear — the whole point of this
      // command for most users. GraphDatabase refuses to open while the
      // directory exists; a killed sync leaves it behind as a stale, empty dir.
      // We reach here only when no live indexer holds the process lock (checked
      // above), so removing it is safe.
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
