import { Command } from 'commander';
import { dim, reset, violet, bold, section } from '../ui';

export function register(program: Command): void {
  program
    .command('context <task>')
    .description('Build relevant code context for a task')
    .option('--max-nodes <n>', 'Max symbols to include', '20')
    .option('--no-code', 'Exclude code snippets')
    .option('--format <fmt>', 'Output format: markdown, json', 'markdown')
    .action(async (task: string, opts: { maxNodes: string; code: boolean; format: string }) => {
      const KiroGraph = (await import('../../index')).default;
      const { trackCliToolSaving } = await import('./utils');

      const cwd = process.cwd();
      const cg = await KiroGraph.open(cwd);
      const ctx = await cg.buildContext(task, {
        maxNodes: parseInt(opts.maxNodes),
        includeCode: opts.code,
      });

      let output: string;

      if (opts.format === 'json') {
        output = JSON.stringify({
          task: ctx.task,
          summary: ctx.summary,
          entryPoints: ctx.entryPoints.map((n: any) => ({ kind: n.kind, name: n.name, file: n.filePath, line: n.startLine })),
          relatedNodes: ctx.relatedNodes.map((n: any) => ({ kind: n.kind, name: n.name, file: n.filePath, line: n.startLine })),
          codeSnippets: Object.fromEntries(ctx.codeSnippets),
        }, null, 2);
        console.log(output);
      } else {
        // Markdown output
        const lines: string[] = [];
        lines.push(`\n  ${section('Context:')} ${violet}${bold}${ctx.task}${reset}\n`);
        lines.push(`  ${dim}${ctx.summary}${reset}`);
        if (ctx.entryPoints.length > 0) {
          lines.push(`\n  ${section('Entry Points')}\n`);
          for (const n of ctx.entryPoints) {
            lines.push(`  ${violet}${bold}${n.name}${reset}  ${dim}${n.kind}  ${n.filePath}:${n.startLine}${reset}`);
            if (ctx.codeSnippets.has(n.id)) {
              lines.push(`\n  ${dim}\`\`\`${reset}`);
              for (const line of (ctx.codeSnippets.get(n.id) ?? '').split('\n')) {
                lines.push(`  ${line}`);
              }
              lines.push(`  ${dim}\`\`\`${reset}\n`);
            }
          }
        }
        if (ctx.relatedNodes.length > 0) {
          lines.push(`\n  ${section('Related Symbols')}\n`);
          for (const n of ctx.relatedNodes) {
            lines.push(`  ${dim}·${reset} ${violet}${n.name}${reset}  ${dim}${n.kind}  ${n.filePath}:${n.startLine}${reset}`);
          }
          lines.push('');
        }
        output = lines.join('\n');
        console.log(output);
      }

      // Track graph tool savings
      trackCliToolSaving(cwd, 'kirograph_context', output, { maxNodes: parseInt(opts.maxNodes) });

      cg.close();
    });
}
