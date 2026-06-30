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
    .command('gini [projectPath]')
    .description('Compute Gini inequality coefficient on a metric across function/method nodes')
    .option('--metric <m>', 'Metric to use: loc | fan-in | fan-out (default: loc)', 'loc')
    .action(async (projectPath: string | undefined, opts: { metric: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_gini', { metric: opts.metric });
    });
}
