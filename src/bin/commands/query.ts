import { Command } from 'commander';
import { dim, reset, violet, bold } from '../ui';

export function register(program: Command): void {
  program
    .command('query <search>')
    .description('Search for symbols')
    .option('--kind <kind>', 'Filter by kind')
    .option('--limit <n>', 'Max results', '10')
    .option('--qualified', 'Treat search as a fully-qualified name (exact match)')
    .option('--similar', 'Use fuzzy/substring matching (broader results)')
    .action(async (search: string, opts: { kind?: string; limit: string; qualified?: boolean; similar?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const { trackCliToolSaving } = await import('./utils');

      const cwd = process.cwd();

      if (opts.qualified) {
        const cg = await KiroGraph.open(cwd);
        const { ToolHandler } = await import('../../mcp/handler');
        const handler = new ToolHandler(cg);
        const result = await handler.handle('kirograph_node', { symbol: search, qualified: true });
        console.log(result.content[0]?.text ?? 'No result');
        cg.close();
        return;
      }

      const cg = await KiroGraph.open(cwd);

      if (opts.similar) {
        const { ToolHandler } = await import('../../mcp/handler');
        const handler = new ToolHandler(cg);
        const result = await handler.handle('kirograph_search', { query: search, mode: 'similar', kind: opts.kind, limit: parseInt(opts.limit) });
        console.log(result.content[0]?.text ?? 'No result');
        trackCliToolSaving(cwd, 'kirograph_search', result.content[0]?.text ?? '', { limit: parseInt(opts.limit) });
        cg.close();
        return;
      }

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
