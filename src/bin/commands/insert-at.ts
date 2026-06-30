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
    .command('insert-at <file> <anchor> <content> [projectPath]')
    .description('Insert content before or after an anchor string or line number in a file')
    .option('--after', 'Insert after anchor instead of before')
    .option('--line', 'Treat anchor as line number')
    .action(async (
      file: string,
      anchor: string,
      content: string,
      projectPath: string | undefined,
      opts: { after?: boolean; line?: boolean },
    ) => {
      const target = path.resolve(projectPath ?? process.cwd());
      await runTool(target, 'kirograph_insert_at', { file, anchor, content, after: opts.after, line: opts.line });
    });
}
