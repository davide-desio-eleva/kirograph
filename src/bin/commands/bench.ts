import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { dim, reset } from '../ui';

const BENCH_QUERIES = [
  { label: 'context:large-task', tool: 'context', task: 'Understand the main entry point and core data flow' },
  { label: 'context:small-task', tool: 'context', task: 'Find authentication logic' },
  { label: 'search:function', tool: 'search', query: 'handle' },
];

export function register(program: Command): void {
  program.command('bench [projectPath]')
    .description('Quick token-efficiency benchmark on the current project')
    .option('--quiet', 'Output only the summary line')
    .action(async (projectPath: string | undefined, opts: { quiet?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(target)) {
        console.error('Project not indexed. Run: kirograph index');
        process.exit(1);
      }
      const cg = await KiroGraph.open(target);

      // Estimate naive token cost: sum all source file sizes / 4
      const allNodes = cg.getAllNodes();
      const sourceFiles = [...new Set(allNodes.map((n: any) => n.filePath as string))];
      let naiveTokens = 0;
      for (const fp of sourceFiles) {
        try {
          const fullPath = path.join(target, fp);
          naiveTokens += Math.round(fs.statSync(fullPath).size / 4);
        } catch { /* skip */ }
      }

      if (!opts.quiet) {
        console.log('\n  KiroGraph Local Bench');
        console.log('  ' + dim + sourceFiles.length + ' source files, ~' + naiveTokens.toLocaleString() + ' naive tokens' + reset);
        console.log('');
      }

      let totalGraphTokens = 0;
      let queryCount = 0;
      for (const q of BENCH_QUERIES) {
        const start = Date.now();
        let responseText = '';
        try {
          if (q.tool === 'context') {
            const ctx = await cg.buildContext(q.task as string, { maxNodes: 20, includeCode: true });
            responseText = ctx.summary + ctx.entryPoints.map((n: any) => n.name).join(' ');
            for (const [, code] of ctx.codeSnippets) responseText += code;
          } else {
            const results = cg.searchNodes(q.query as string, undefined, 20);
            responseText = results.map((r: any) => r.node.name + ' ' + r.node.filePath).join('\n');
          }
        } catch { /* skip */ }
        const graphTok = Math.round(responseText.length / 4);
        totalGraphTokens += graphTok;
        queryCount++;
        const ms = Date.now() - start;
        if (!opts.quiet) {
          const savings = naiveTokens > 0 ? Math.round((1 - graphTok / naiveTokens) * 100) : 0;
          console.log('  ' + q.label + ': ' + graphTok + ' tok (' + savings + '% savings, ' + ms + 'ms)');
        }
      }
      cg.close();

      const avgTok = Math.round(totalGraphTokens / queryCount);
      const avgSavings = naiveTokens > 0 ? Math.round((1 - avgTok / naiveTokens) * 100) : 0;
      console.log('');
      console.log('  avg ' + avgSavings + '% token savings vs naive file reading');
      console.log('');
    });
}
