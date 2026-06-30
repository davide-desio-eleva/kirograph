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
    .command('dsm [projectPath]')
    .description('Dependency Structure Matrix — detect strongly coupled module groups')
    .option('--limit <n>', 'Max groups to show (default: 15)', '15')
    .action(async (projectPath: string | undefined, opts: { limit: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 15;
      await runTool(target, 'kirograph_dsm', { limit });
    });
}
