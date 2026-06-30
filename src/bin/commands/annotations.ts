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
    .command('annotations [projectPath]')
    .description('Decorator/attribute histogram across the codebase')
    .option('--decorator <name>', 'Filter by decorator name')
    .option('--limit <n>', 'Max results', '20')
    .action(async (projectPath: string | undefined, opts: { decorator?: string; limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 20;
      await runTool(target, 'kirograph_annotations', { decorator: opts.decorator, limit });
    });
}
