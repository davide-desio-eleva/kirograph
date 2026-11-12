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
    .option('--background', 'Start the sync in a separate process and return at once (for hooks that are stopped after a time limit)')
    .option('--errors', 'List the files that failed in the last sync or index, and exit')
    .option('--full', 'Check every file even when nothing seems to have changed')
    .option('--timings', 'Print the time spent in each phase when the sync ends')
    .action(async (projectPath: string | undefined, opts: { files?: string[]; quiet?: boolean; progress?: boolean; timings?: boolean; full?: boolean; errors?: boolean; background?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      if (opts.errors) {
        const { readSyncErrors } = await import('../../sync/state');
        const last = readSyncErrors(target);
        if (!last) { console.log(`  ${dim}The last sync had no errors.${reset}`); return; }
        console.log(`  ${last.total} error(s) in the sync of ${new Date(last.at).toLocaleString()}:\n`);
        for (const e of last.errors) console.log(`    ${e}`);
        if (last.total > last.errors.length) console.log(`\n  ${dim}... and ${last.total - last.errors.length} more.${reset}`);
        return;
      }

      // Nothing changed since the last sync: answer without opening the database or loading the
      // library (see sync/state.ts)
      if (!opts.files && !opts.full && !opts.timings) {
        const { quickIsUpToDate } = await import('../../sync/state');
        if (quickIsUpToDate(target)) {
          if (!opts.quiet) {
            process.stdout.write('\n');
            console.log(`  ${dim}Nothing to sync — index is up to date.${reset}`);
            const { readSyncErrors } = await import('../../sync/state');
            const last = readSyncErrors(target);
            if (last) console.warn(`  \x1b[33m⚠ ${last.total} warning(s) from the last sync: kirograph sync --errors lists them\x1b[0m`);
          }
          return;
        }
      }

      if (opts.background && !opts.files) {
        const { startBackgroundSync } = await import('./background');
        startBackgroundSync(target);
        return;
      }

      // A running MCP server for this project does the sync itself: it has the database open, and
      // a second process would contend with it for the lock. Needs the plain, default run.
      if (!opts.files && !opts.progress && !opts.timings) {
        const { requestSync } = await import('../../sync/remote');
        const remote = await requestSync(target, { full: opts.full });
        if (remote?.ok && remote.result) {
          const r = remote.result as import('../../types').SyncResult;
          if (!opts.quiet) {
            if (r.added.length + r.modified.length + r.removed.length === 0) {
              process.stdout.write('\n');
              console.log(`  ${dim}Nothing to sync — index is up to date.${reset}`);
            } else {
              renderSyncSummary(r);
            }
          }
          if (r.errors.length) console.warn(`  \x1b[33m⚠ ${r.errors.length} warning(s)\x1b[0m`);
          return;
        }
      }

      const KiroGraph = (await import('../../index')).default;
      const cg = await KiroGraph.open(target, undefined, { deferVectors: true });

      let progressHandler: ((p: import('../../types').IndexProgress) => void) | undefined;
      if (opts.quiet) {
        progressHandler = undefined;
      } else if (opts.progress) {
        progressHandler = renderSyncProgressVerbose;
      } else {
        progressHandler = renderSyncProgress;
      }

      // --timings: add up the time between phase changes, whatever the progress output is
      const phaseMs = new Map<string, number>();
      let phase: string | null = null;
      let phaseStart = 0;
      const syncStart = Date.now();
      if (opts.timings) {
        const inner = progressHandler;
        progressHandler = p => {
          if (p.phase !== phase) {
            const now = Date.now();
            if (phase) phaseMs.set(phase, (phaseMs.get(phase) ?? 0) + now - phaseStart);
            phase = p.phase;
            phaseStart = now;
          }
          inner?.(p);
        };
      }

      const result = await cg.sync({
        files: opts.files,
        onProgress: progressHandler,
        full: opts.full,
      });

      if (opts.timings) {
        if (phase) phaseMs.set(phase, (phaseMs.get(phase) ?? 0) + Date.now() - phaseStart);
        console.log(`\n  Time per phase (total ${Date.now() - syncStart} ms):`);
        for (const [name, ms] of [...phaseMs].sort((a, b) => b[1] - a[1])) {
          console.log(`    ${String(ms).padStart(7)} ms  ${name}`);
        }
      }

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
          console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s): kirograph sync --errors lists them\x1b[0m`);
        }
      }

      warnFallback(cg.getEngineFallback());
      cg.close();
    });
}
