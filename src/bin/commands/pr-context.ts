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
    .command('pr-context <base> [head] [projectPath]')
    .description('Semantic diff between two git refs for PR descriptions')
    .option('--format <fmt>', 'Output format: text|json (default: text)', 'text')
    .action(async (base: string, head: string | undefined, projectPath: string | undefined, opts: { format: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_pr_context', { base, head: head ?? 'HEAD' });
    });
}
