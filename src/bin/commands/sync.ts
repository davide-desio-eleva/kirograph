import { Command } from 'commander';
import * as path from 'path';
import { dim, reset } from '../ui';
import { renderSyncProgress, renderSyncProgressVerbose, renderSyncSummary } from '../progress';
import { warnFallback } from './utils';

export function register(program: Command): void {
  program
    .command('sync [projectPath]')
    .description('Incremental sync of changed files')
    .option('--files <files...>', 'Specific files to sync')
    .option('-q, --quiet', 'Suppress progress output')
    .option('--progress', 'Verbose per-file progress output (implies errors are shown inline)')
    .action(async (projectPath: string | undefined, opts: { files?: string[]; quiet?: boolean; progress?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);

      let progressHandler: ((p: import('../../types').IndexProgress) => void) | undefined;
      if (opts.quiet) {
        progressHandler = undefined;
      } else if (opts.progress) {
        progressHandler = renderSyncProgressVerbose;
      } else {
        progressHandler = renderSyncProgress;
      }

      const result = await cg.sync({
        files: opts.files,
        onProgress: progressHandler,
      });

      const changed = result.added.length + result.modified.length + result.removed.length;
      if (changed === 0) {
        if (!opts.quiet) process.stdout.write('\n');
        console.log(`  ${dim}Nothing to sync — index is up to date.${reset}`);
      } else {
        renderSyncSummary(result);
      }

      // In --progress mode, print errors inline with full detail
      if (result.errors.length) {
        if (opts.progress) {
          console.warn(`\n  \x1b[33m⚠ ${result.errors.length} error(s) during sync:\x1b[0m`);
          for (const err of result.errors) {
            console.warn(`    \x1b[33m${err}\x1b[0m`);
          }
        } else {
          console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
        }
      }

      warnFallback(cg.getEngineFallback());
      cg.close();
    });
}
