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
    .command('diff-context [projectPath]')
    .description('Show changed symbols (unstaged or staged), their callers/callees, and affected tests')
    .option('--staged', 'Use staged changes only')
    .option('--ref <ref>', 'Compare against git ref')
    .action(async (projectPath: string | undefined, opts: { staged?: boolean; ref?: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_diff_context', { staged: opts.staged, ref: opts.ref });
    });
}
