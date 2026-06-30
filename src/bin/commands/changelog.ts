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
    .command('changelog <ref1> <ref2> [projectPath]')
    .description('Human-readable semantic diff between two git refs')
    .action(async (ref1: string, ref2: string, projectPath: string | undefined) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_changelog', { ref1, ref2 });
    });
}
