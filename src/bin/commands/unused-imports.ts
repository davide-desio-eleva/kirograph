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
    .command('unused-imports [projectPath]')
    .description('Find import nodes with zero resolved downstream edges')
    .option('--limit <n>', 'Max results (default: 50)', '50')
    .action(async (projectPath: string | undefined, opts: { limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_unused_imports', { limit: parseInt(opts.limit) });
    });
}
