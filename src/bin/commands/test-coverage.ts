import * as path from 'path';
import { Command } from 'commander';

async function runTool(target: string, toolName: string, args: Record<string, unknown>): Promise<void> {
  const KiroGraph = (await import('../../index')).default;
  const { ToolHandler } = (await import('../../mcp/handler')) as any;
  const cg = await KiroGraph.open(target);
  const handler = new ToolHandler(cg);
  const result = await handler.handle(toolName, { ...args, projectPath: target });
  cg.close();
  const text: string = result.content.map((c: any) => c.text).join('');
  console.log(text);
}

export function register(program: Command): void {
  program
    .command('test-coverage [projectPath]')
    .description('Show test coverage gaps sorted by worst coverage first')
    .option('--sort <order>', 'Sort order: asc (worst first) | desc (best first) (default: asc)', 'asc')
    .option('--limit <n>', 'Max results (default: 30)', '30')
    .action(async (projectPath: string | undefined, opts: { sort: string; limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 30;
      await runTool(target, 'kirograph_test_coverage', {
        sort: opts.sort,
        limit,
      });
    });
}
