import { Command } from 'commander';
import * as path from 'path';
import { printBanner } from '../banner';
import { renderIndexProgress } from '../progress';
import { dim, reset, violet, bold, green, value } from '../ui';
import { warnFallback } from './utils';

export function register(program: Command): void {
  program
    .command('init [projectPath]')
    .description('Initialize KiroGraph in a project')
    .option('-i, --index', 'Index immediately after init')
    .action(async (projectPath: string | undefined, opts: { index?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      if (KiroGraph.isInitialized(target)) {
        console.log(`  ${dim}KiroGraph already initialized at ${target}${reset}`);
      } else {
        await KiroGraph.init(target);
        console.log(`  ${green}✓${reset} Initialized ${violet}${bold}.kirograph/${reset} in ${dim}${target}${reset}`);
      }
      if (opts.index) {
        const cg = await KiroGraph.open(target);
        console.log(`\n  ${dim}Indexing...${reset}`);
        const result = await cg.indexAll({
          force: true,
          onProgress: renderIndexProgress,
        });
        process.stdout.write('\n');
        console.log(`  ${green}✓${reset} ${value(String(result.filesIndexed))} ${dim}files,${reset} ${value(String(result.nodesCreated))} ${dim}symbols,${reset} ${value(String(result.edgesCreated))} ${dim}edges${reset} ${dim}(${result.duration}ms)${reset}`);
        if (result.errors.length) console.warn(`  \x1b[33m⚠ ${result.errors.length} warning(s)\x1b[0m`);
        warnFallback(cg.getEngineFallback());
        cg.close();
      }
    });
}
