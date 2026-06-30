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
  const sessionCmd = program
    .command('session')
    .description('Save or compare session baselines for tracking changes');

  sessionCmd
    .command('start [projectPath]')
    .description('Save session baseline for tracking changes')
    .action(async (projectPath: string | undefined) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_session_start', {});
    });

  sessionCmd
    .command('end [projectPath]')
    .description('Show changes since session baseline')
    .action(async (projectPath: string | undefined) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_session_end', {});
    });
}
