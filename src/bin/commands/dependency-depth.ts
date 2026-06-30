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
    .command('dependency-depth [projectPath]')
    .description('Compute topological depth of each file in the import graph (Kahn\'s algorithm)')
    .option('--limit <n>', 'Max files to show (default: 20)', '20')
    .action(async (projectPath: string | undefined, opts: { limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_dependency_depth', { limit: parseInt(opts.limit) });
    });
}
