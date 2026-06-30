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
    .command('str-replace <file> <old-str> <new-str> [projectPath]')
    .description('Replace unique string anchor in a file; fails on 0 or >1 matches')
    .action(async (file: string, oldStr: string, newStr: string, projectPath: string | undefined) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_str_replace', { file, old_str: oldStr, new_str: newStr });
    });
}
