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
    .command('rank [projectPath]')
    .description('Symbols ranked by fan-in or fan-out edge count')
    .option('--by <by>', 'Rank by (fan-in|fan-out)', 'fan-in')
    .option('--limit <n>', 'Max results', '20')
    .action(async (projectPath: string | undefined, opts: { by?: string; limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 20;
      await runTool(target, 'kirograph_rank', { by: opts.by || 'fan-in', limit });
    });
}
