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
    .command('multi-replace <file> <pairs-json> [projectPath]')
    .description('Multiple string replacements as an all-or-nothing transaction')
    .action(async (file: string, pairsJson: string, projectPath: string | undefined) => {
      const target = path.resolve(projectPath ?? process.cwd());

      let pairs: Array<{ old_str: string; new_str: string }>;
      try {
        pairs = JSON.parse(pairsJson);
      } catch {
        console.error(`\n  Error: pairs-json must be a valid JSON array of {old_str, new_str} objects.\n`);
        console.error(`  Example: '[{"old_str":"foo","new_str":"bar"},{"old_str":"baz","new_str":"qux"}]'\n`);
        process.exit(1);
      }

      await runTool(target, 'kirograph_multi_str_replace', { file, pairs });
    });
}
