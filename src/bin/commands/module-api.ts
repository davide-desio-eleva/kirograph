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
    .command('module-api [path] [projectPath]')
    .description('List all exported symbols in a file or directory')
    .option('--limit <n>', 'Max results', '50')
    .option('--format <fmt>', 'Output format (table|json)', 'table')
    .action(async (pathArg: string | undefined, projectPath: string | undefined, opts: { limit: string; format: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 50;
      const { format } = opts;
      await runTool(target, 'kirograph_module_api', { path: pathArg, limit, format });
    });
}
