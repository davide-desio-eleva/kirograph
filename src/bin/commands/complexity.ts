import * as path from 'path';
import { Command } from 'commander';
import { dim, reset, violet, bold } from '../ui';

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
    .command('complexity [projectPath]')
    .description('Rank functions by cyclomatic complexity, cognitive complexity, and maintainability index')
    .option('--limit <n>', 'Max results (default: 20)', '20')
    .option('--sort <by>', 'Sort by: cyclomatic | cognitive | maintainability (default: cyclomatic)', 'cyclomatic')
    .option('--threshold <n>', 'Only show results above this threshold')
    .action(async (
      projectPath: string | undefined,
      opts: { limit: string; sort: string; threshold?: string },
    ) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 20;
      await runTool(target, 'kirograph_complexity', {
        limit,
        sortBy: opts.sort,
        threshold: opts.threshold ? parseInt(opts.threshold) : undefined,
      });
    });
}
