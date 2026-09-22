import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from '../../config';
import { dim, reset, violet, bold, green } from '../ui';

const red    = '\x1b[31m';
const yellow = '\x1b[33m';

export function register(program: Command): void {
  program
    .command('reachability <target> [projectPath]')
    .description('Check reachability for a dependency or CVE: verdict, call paths, impact summary')
    .option('--explain', 'Print a plain-English explanation of why the verdict was reached')
    .action(async (target: string, projectPath: string | undefined, opts: { explain?: boolean }) => {
      const projectRoot = path.resolve(projectPath ?? process.cwd());
      const config = await loadConfig(projectRoot);

      if (!config.enableSecurity) {
        console.error(`\n  ${yellow}⚠ Security analysis is disabled.${reset}`);
        console.error(`  ${dim}Enable it in .kirograph/config.json:${reset} ${violet}${bold}"enableSecurity": true${reset}`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}\n`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(projectRoot)) {
        console.error('  ✖ KiroGraph not initialized. Run: kirograph init');
        process.exit(1);
      }

      const cg = await KiroGraph.open(projectRoot);
      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      // Resolve target to a vulnerability node ID (CVE ID or package name)
      let vulnerabilityNodeId: string | null = null;
      let targetLabel = target;

      const vulnRow: { node_id: string } | undefined = rawDb.get(
        `SELECT node_id FROM sec_vulnerabilities WHERE cve_id = ?`,
        [target],
      );

      if (vulnRow) {
        vulnerabilityNodeId = vulnRow.node_id;
      } else {
        const depRow: { node_id: string; package_name: string } | undefined = rawDb.get(
          `SELECT node_id, package_name FROM sec_dependencies WHERE package_name = ?`,
          [target],
        );

        if (depRow) {
          targetLabel = depRow.package_name;
          const vulnEdge: { target: string } | undefined = rawDb.get(
            `SELECT target FROM edges WHERE source = ? AND kind = 'has_vulnerability' LIMIT 1`,
            [depRow.node_id],
          );

          if (vulnEdge) {
            vulnerabilityNodeId = vulnEdge.target;
          } else {
            console.error(`\n  ${dim}No vulnerabilities found for dependency "${target}". The dependency exists but has no known CVEs.${reset}\n`);
            cg.close();
            process.exit(0);
          }
        } else {
          console.error(`\n  ✖ Target "${target}" not found. Provide a valid CVE ID or dependency package name.\n`);
          cg.close();
          process.exit(1);
        }
      }

      const { ReachabilityAnalyzer, explainReachability } = await import('../../security/reachability');
      const analyzer = new ReachabilityAnalyzer(db, config);
      const result = await analyzer.analyze(vulnerabilityNodeId);

      // Verdict line
      let verdictColor: string;
      let verdictLabel: string;
      if (result.verdict === 'affected') {
        verdictColor = red; verdictLabel = 'affected';
      } else if (result.verdict === 'not_affected') {
        verdictColor = green; verdictLabel = 'not affected';
      } else {
        verdictColor = yellow; verdictLabel = 'under investigation';
      }

      console.log(`\n  ${violet}${bold}Reachability:${reset} ${targetLabel}`);
      console.log(`  ${dim}Verdict:${reset}                ${verdictColor}${bold}${verdictLabel}${reset}`);
      console.log(`  ${dim}Reaching entry points:${reset}  ${bold}${result.reachingEntryPointCount}${reset}`);

      if (opts.explain) {
        console.log(`\n  ${violet}${bold}Explanation${reset}`);
        console.log(`  ${dim}${explainReachability(result)}${reset}`);
      }

      // Call paths
      if (result.paths.length > 0) {
        console.log(`\n  ${violet}${bold}Call Paths${reset}  ${dim}(showing up to 5)${reset}\n`);
        for (const p of result.paths.slice(0, 5)) {
          console.log(`  ${dim}from${reset} ${violet}${p.entryPoint}${reset}`);
          console.log(`    ${p.path.join(` ${dim}→${reset} `)}`);
        }
        if (result.paths.length > 5) {
          console.log(`\n  ${dim}…and ${result.paths.length - 5} more paths${reset}`);
        }
      }

      // Unresolved symbols
      if (result.unresolvedSymbols.length > 0) {
        console.log(`\n  ${yellow}Unresolved Symbols${reset}  ${dim}(${result.unresolvedSymbols.length} total, showing up to 10)${reset}\n`);
        for (const sym of result.unresolvedSymbols.slice(0, 10)) {
          console.log(`  ${dim}·${reset} ${sym}`);
        }
        if (result.unresolvedSymbols.length > 10) {
          console.log(`  ${dim}…and ${result.unresolvedSymbols.length - 10} more${reset}`);
        }
      }

      // Impact summary (only when affected)
      if (result.verdict === 'affected') {
        const impact = await analyzer.getImpactSummary(vulnerabilityNodeId);
        if (impact) {
          console.log(`\n  ${violet}${bold}Impact Summary${reset}\n`);
          if (impact.affectedLayers.length > 0) {
            console.log(`  ${dim}Affected layers:${reset}       ${impact.affectedLayers.join(', ')}`);
          }
          console.log(`  ${dim}Affected entry points:${reset} ${bold}${impact.affectedEntryPoints.length}${reset}`);
          console.log(`  ${dim}Distinct paths:${reset}        ${bold}${impact.distinctPathCount}${reset}`);
        }
      }

      console.log();
      cg.close();
    });
}
