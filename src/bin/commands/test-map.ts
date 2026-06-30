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
    .command('test-map [symbol] [projectPath]')
    .description('Map symbols to test files; show uncovered symbols when no symbol given')
    .option('--limit <n>', 'Max results (default: 20)', '20')
    .action(async (symbol: string | undefined, projectPath: string | undefined, opts: { limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = Math.max(1, Math.min(200, parseInt(opts.limit) || 20));
      await runTool(target, 'kirograph_test_map', { symbol, limit });
    });
}
