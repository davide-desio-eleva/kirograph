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
    .command('test-risk [projectPath]')
    .description('Rank untested or under-tested code paths by risk score')
    .option('--limit <n>', 'Max results (default: 20)', '20')
    .option('--threshold <n>', 'Min risk score to include')
    .action(async (projectPath: string | undefined, opts: { limit: string; threshold?: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 20;
      await runTool(target, 'kirograph_test_risk', {
        limit,
        threshold: opts.threshold ? parseInt(opts.threshold) : undefined,
      });
    });
}
