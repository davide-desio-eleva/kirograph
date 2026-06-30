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
    .command('doc-coverage [projectPath]')
    .description('Find exported symbols missing docstrings')
    .option('--limit <n>', 'Max results', '50')
    .option('--path <p>', 'File/dir filter')
    .action(async (projectPath: string | undefined, opts: { limit: string; path?: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const limit = parseInt(opts.limit) || 50;
      await runTool(target, 'kirograph_doc_coverage', { path: opts.path, limit });
    });
}
