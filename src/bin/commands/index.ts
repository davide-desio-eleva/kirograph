import { Command } from 'commander';
import * as path from 'path';
import { renderIndexProgress } from '../progress';
import { dim, reset, green, value } from '../ui';
import { warnFallback } from './utils';
import { loadConfig } from '../../config';

export function register(program: Command): void {
  program
    .command('index [projectPath]')
    .description('Full index of a project')
    .option('--force', 'Force re-index all files')
    .action(async (projectPath: string | undefined, opts: { force?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const result = await cg.indexAll({
        force: opts.force,
        onProgress: renderIndexProgress,
      });
      process.stdout.write('\n');
      console.log(`  ${green}✓${reset} ${value(String(result.filesIndexed))} ${dim}files,${reset} ${value(String(result.nodesCreated))} ${dim}symbols,${reset} ${value(String(result.edgesCreated))} ${dim}edges${reset} ${dim}(${result.duration}ms)${reset}`);
      if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
      warnFallback(cg.getEngineFallback());

      // PixelRAG visual PDF index (experimental, only if enabled)
      const config = await loadConfig(target);
      if (config.enableVisualPDF) {
        const kirographDir = path.join(target, '.kirograph');
        try {
          const { ensurePython, ensurePixelRAGInstalled, getFlaggedPdfs, buildIndex } = await import('../../data/pixelrag-manager');
          const python = ensurePython();
          ensurePixelRAGInstalled(python);

          const db = cg.getDatabase();
          db.applyDataSchema();
          const flaggedPdfs = getFlaggedPdfs(db.getRawDb(), target);

          buildIndex({ python, flaggedPdfs, projectRoot: target, kirographDir, force: opts.force });
        } catch (err) {
          console.warn(`  \x1b[33m⚠ PixelRAG: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
      }

      cg.close();
    });
}
