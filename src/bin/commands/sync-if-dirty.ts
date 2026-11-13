import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { dim, reset } from '../ui';
import { warnFallback, formatSyncCounts } from './utils';

export function register(program: Command): void {
  program
    .command('sync-if-dirty [projectPath]')
    .description('Sync only if a dirty marker is present')
    .option('-q, --quiet', 'Suppress output')
    .option('--background', 'When there is something to sync, start it in a separate process and return at once')
    .action(async (projectPath: string | undefined, opts: { quiet?: boolean; background?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      // Not dirty and nothing known to have changed: answer without opening the database or
      // loading the library
      if (!fs.existsSync(path.join(target, '.kirograph'))) return;
      const { quickShouldSyncIfDirty } = await import('../../sync/state');
      if (!quickShouldSyncIfDirty(target)) {
        if (!opts.quiet) console.log(`  ${dim}Not dirty, skipped.${reset}`);
        return;
      }

      if (opts.background) {
        const { startBackgroundSync } = await import('./background');
        startBackgroundSync(target);
        return;
      }

      // A running MCP server for this project decides and syncs itself (see sync/remote.ts)
      const { requestSync } = await import('../../sync/remote');
      const remote = await requestSync(target, { ifDirty: true });
      if (remote?.ok) {
        if (!opts.quiet) {
          const r = remote.result as import('../../types').SyncResult | null;
          if (!r) console.log(`  ${dim}Not dirty, skipped.${reset}`);
          else if (r.added.length + r.modified.length + r.removed.length === 0) console.log(`  ${dim}Index up to date.${reset}`);
          else console.log(formatSyncCounts(r));
          if (r?.errors.length) console.warn(`  \x1b[33m⚠ ${r.errors.length} warning(s)\x1b[0m`);
        }
        return;
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(target)) { process.exit(0); }
      const cg = await KiroGraph.open(target, undefined, { deferVectors: true });
      const result = await cg.syncIfDirty();
      if (!opts.quiet) {
        if (result) {
          const changed = result.added.length + result.modified.length + result.removed.length;
          if (changed === 0) {
            console.log(`  ${dim}Index up to date.${reset}`);
          } else {
            console.log(formatSyncCounts(result));
          }
          if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
          warnFallback(cg.getEngineFallback());
        } else {
          console.log(`  ${dim}Not dirty, skipped.${reset}`);
        }
      }
      cg.close();
    });
}
