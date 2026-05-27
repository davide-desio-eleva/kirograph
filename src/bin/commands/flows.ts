import { Command } from 'commander';
import * as path from 'path';
import { dim, reset, violet, bold, green } from '../ui';

export function register(program: Command): void {
  program
    .command('flows [projectPath]')
    .description('Trace execution flows from entry points through the call graph')
    .option('--entry <symbol>', 'Trace from a specific symbol (auto-detects if omitted)')
    .option('--max-flows <n>', 'Max flows to return', '10')
    .option('--max-depth <n>', 'Max call chain depth', '10')
    .option('--json', 'Output as JSON')
    .action(async (projectPath: string | undefined, opts: { entry?: string; maxFlows: string; maxDepth: string; json?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const { getExecutionFlows, traceFlow, detectEntryPoints } = await import('../../graph/flows');
      const db = cg.getDatabase();

      if (opts.entry) {
        const results = cg.searchNodes(opts.entry, undefined, 5);
        if (results.length === 0) {
          console.error(`  Symbol "${opts.entry}" not found.`);
          cg.close();
          process.exit(1);
        }
        const hops = traceFlow(db, results[0].node.id, parseInt(opts.maxDepth));

        if (opts.json) {
          console.log(JSON.stringify(hops, null, 2));
        } else {
          console.log(`\n  ${bold}Flow from${reset} ${violet}${opts.entry}${reset}\n`);
          for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];
            const indent = '  '.repeat(i + 1);
            const arrow = i === 0 ? '→' : '↳';
            const conf = hop.confidence && hop.confidence !== 'extracted' ? ` ${dim}[${hop.confidence}]${reset}` : '';
            console.log(`${indent}${arrow} ${hop.kind} ${violet}${hop.symbol}${reset} — ${dim}${hop.filePath}:${hop.line}${reset}${conf}`);
          }
        }
      } else {
        const flows = getExecutionFlows(db, {
          maxFlows: parseInt(opts.maxFlows),
          maxDepth: parseInt(opts.maxDepth),
        });

        if (opts.json) {
          console.log(JSON.stringify(flows, null, 2));
        } else {
          console.log(`\n  ${bold}Execution Flows${reset} (${flows.length} detected)\n`);
          for (const flow of flows) {
            console.log(`  ${green}${flow.entryPoint}${reset} (${flow.entryPointKind}) — criticality: ${flow.criticality.toFixed(2)}`);
            console.log(`  ${dim}${flow.entryPointFile}${reset}`);
            for (let i = 0; i < Math.min(flow.hops.length, 6); i++) {
              const hop = flow.hops[i];
              const indent = '  ' + '  '.repeat(i);
              const arrow = i === 0 ? '→' : '↳';
              console.log(`${indent}${arrow} ${dim}${hop.symbol}${reset}`);
            }
            if (flow.hops.length > 6) console.log(`    ${dim}…and ${flow.hops.length - 6} more hops${reset}`);
            console.log();
          }
        }
      }

      cg.close();
    });
}
