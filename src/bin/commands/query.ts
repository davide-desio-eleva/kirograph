import { Command } from 'commander';
import { dim, reset, violet, bold } from '../ui';

export function register(program: Command): void {
  program
    .command('query <search>')
    .description('Search for symbols')
    .option('--kind <kind>', 'Filter by kind')
    .option('--limit <n>', 'Max results', '10')
    .action(async (search: string, opts: { kind?: string; limit: string }) => {
      const KiroGraph = (await import('../../index')).default;
      const { trackCliToolSaving } = await import('./utils');

      const cwd = process.cwd();
      const cg = await KiroGraph.open(cwd);
      const results = cg.searchNodes(search, opts.kind as any, parseInt(opts.limit));
      if (results.length === 0) {
        console.log(`  ${dim}No results for${reset} ${violet}${bold}${search}${reset}`);
      } else {
        console.log();
        for (const r of results) {
          console.log(`  ${violet}${bold}${r.node.name}${reset}  ${dim}${r.node.kind}${reset}  ${dim}${r.node.filePath}:${r.node.startLine}${reset}`);
        }
        console.log(`\n  ${dim}${results.length} result(s)${reset}`);
      }

      // Track savings
      const output = results.map(r => `${r.node.name} ${r.node.kind} ${r.node.filePath}:${r.node.startLine}`).join('\n');
      trackCliToolSaving(cwd, 'kirograph_search', output, { limit: parseInt(opts.limit) });

      cg.close();
    });
}
