/**
 * kirograph read — File read with caching and multiple modes
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

export function register(program: Command): void {
  program
    .command('read <path>')
    .description('Read a file with caching and multiple modes')
    .option('--no-cache', 'Force fresh read, bypass cache')
    .option('--mode <mode>', 'Read mode: full, map, signatures, diff, lines, imports, exports', 'full')
    .option('--start <n>', 'Start line (for lines mode)', parseInt)
    .option('--end <n>', 'End line (for lines mode)', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (filePath: string, opts: { cache: boolean; mode: string; start?: number; end?: number; json?: boolean }) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

      if (!fs.existsSync(resolvedPath)) {
        console.error(`  Error: File not found: ${resolvedPath}`);
        process.exit(1);
      }

      const { getFileReadCache } = await import('../../mcp/cache');
      const { executeReadMode } = await import('../../mcp/read-modes');
      const cache = getFileReadCache();

      const mode = opts.mode as any;
      const noCache = !opts.cache;

      if (mode !== 'full') {
        // For non-full modes, try to get graph connection
        let cg = null;
        try {
          const { findNearestKiroGraphRoot } = await import('../../index');
          const KiroGraph = (await import('../../index')).default;
          const root = findNearestKiroGraphRoot(process.cwd());
          if (root) {
            cg = await KiroGraph.open(root);
          }
        } catch { /* no graph available */ }

        const result = executeReadMode({
          mode,
          filePath: resolvedPath,
          start: opts.start,
          end: opts.end,
          cg,
        });

        // Update cache for future diff mode
        cache.read(resolvedPath, true);

        if (opts.json) {
          console.log(JSON.stringify({ mode: result.mode, tokenEstimate: result.tokenEstimate, content: result.content }, null, 2));
        } else {
          console.log(result.content);
        }

        if (cg) {
          try { (cg as any).close(); } catch { /* ignore */ }
        }
        return;
      }

      // Full mode with caching
      const result = cache.read(resolvedPath, noCache);

      if (opts.json) {
        console.log(JSON.stringify({ cached: result.cached, changed: result.changed, content: result.content }, null, 2));
        return;
      }

      if (result.cached) {
        console.log(result.content);
      } else if (result.changed) {
        console.log(`[file changed since last read]\n`);
        console.log(result.content);
      } else {
        console.log(result.content);
      }
    });
}
