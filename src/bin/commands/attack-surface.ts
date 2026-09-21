import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from '../../config';
import { dim, reset, violet, bold, section } from '../ui';
import type { AttackSurfaceEntry } from '../../security/attack-surface';

const red    = '\x1b[31m';
const yellow = '\x1b[33m';

export function register(program: Command): void {
  program
    .command('attack-surface [projectPath]')
    .description('Map HTTP routes to reachable vulnerable dependencies')
    .option('--limit <n>', 'Max routes to show (default: 20)', '20')
    .option('--public-only', 'Show only public/unauthenticated routes')
    .option('--format <fmt>', 'Output format: text, json (default: text)', 'text')
    .action(async (
      projectPath: string | undefined,
      opts: { limit: string; publicOnly?: boolean; format: string },
    ) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const config = await loadConfig(target);

      if (!config.enableSecurity) {
        console.error(`\n  ${yellow}⚠ Security analysis is disabled.${reset}`);
        console.error(`  ${dim}Enable it in .kirograph/config.json:${reset} ${violet}${bold}"enableSecurity": true${reset}`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}\n`);
        process.exit(1);
      }

      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1) {
        console.error(`  ✖ Invalid --limit value: ${opts.limit}. Must be a positive integer.`);
        process.exit(1);
      }

      const validFormats = ['text', 'json'];
      if (!validFormats.includes(opts.format)) {
        console.error(`  ✖ Invalid --format value: ${opts.format}. Use: text, json`);
        process.exit(1);
      }

      const KiroGraph = (await import('../../index')).default;
      if (!KiroGraph.isInitialized(target)) {
        console.error('  ✖ KiroGraph not initialized. Run: kirograph init');
        process.exit(1);
      }

      const cg = await KiroGraph.open(target);
      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { AttackSurfaceAnalyzer } = await import('../../security/attack-surface');
      const analyzer = new AttackSurfaceAnalyzer(db, {
        authDetectionMode: config.securityAuthDetectionMode,
        authConfidenceThreshold: config.securityAuthConfidenceThreshold,
        jevApiKey: config.jevApiKey,
        jevBaseUrl: config.jevBaseUrl,
        jevModel: config.jevModel,
      });
      let result;
      try {
        result = await analyzer.analyze();
      } catch (err) {
        console.error(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
        cg.close(); process.exit(1);
      }

      cg.close();

      // Apply --public-only filter
      let routes = opts.publicOnly
        ? result.allRoutes.filter(r => r.exposureLevel === 'public')
        : result.allRoutes;

      // Apply limit
      const limited = routes.slice(0, limit);

      // ── JSON output ────────────────────────────────────────────────────────────
      if (opts.format === 'json') {
        console.log(JSON.stringify(
          {
            totalRoutes: result.totalRoutes,
            publicRoutes: result.publicRoutes,
            authenticatedRoutes: result.authenticatedRoutes,
            routesWithVulns: result.routesWithVulns,
            criticalPaths: result.criticalPaths,
            routes: limited,
          },
          null,
          2,
        ));
        return;
      }

      // ── Text output ────────────────────────────────────────────────────────────
      const totalLabel = result.totalRoutes === 1 ? 'route' : 'routes';
      console.log(
        `\n  ${section('Attack Surface')}  ` +
        `${dim}(${result.totalRoutes} ${totalLabel} total: ${result.publicRoutes} public, ${result.authenticatedRoutes} authenticated)${reset}\n`,
      );

      if (result.criticalPaths.length === 0) {
        console.log(`  ${dim}No routes reaching vulnerable dependencies found.${reset}\n`);
        return;
      }

      // Critical paths section
      console.log(`  ${violet}${bold}● Critical paths${reset} ${dim}(routes reaching affected vulnerabilities)${reset}\n`);

      const criticalToShow = result.criticalPaths.slice(0, limit);

      for (const entry of criticalToShow) {
        printRouteEntry(entry);
      }

      // If public-only was not set, also show clean routes summary
      if (!opts.publicOnly) {
        const cleanCount = result.totalRoutes - result.routesWithVulns;
        if (cleanCount > 0) {
          console.log(`  ${dim}+ ${cleanCount} clean route${cleanCount === 1 ? '' : 's'} (no reachable vulnerabilities)${reset}\n`);
        }
      }
    });
}

function printRouteEntry(entry: AttackSurfaceEntry): void {
  const isPublicVuln = entry.exposureLevel === 'public' && entry.vulnerableDeps.length > 0;
  const isAuthVuln   = (entry.exposureLevel === 'authenticated' || entry.exposureLevel === 'internal') && entry.vulnerableDeps.length > 0;

  const routeColor = isPublicVuln ? red : isAuthVuln ? yellow : dim;
  const riskLabel  = entry.riskScore > 0 ? `${entry.riskScore.toFixed(1)}` : '?';

  // Exposure badge
  const exposureBadge = (() => {
    switch (entry.exposureLevel) {
      case 'public':        return `${red}public${reset}     `;
      case 'authenticated': return `${yellow}authenticated${reset}`;
      case 'internal':      return `${dim}internal${reset}   `;
      default:              return `${dim}unknown${reset}    `;
    }
  })();

  // Pick the top vuln by riskScore to show inline
  const topVuln = entry.vulnerableDeps.reduce<AttackSurfaceEntry['vulnerableDeps'][0] | null>(
    (best, v) => {
      if (!best) return v;
      if ((v.riskScore ?? 0) > (best.riskScore ?? 0)) return v;
      return best;
    },
    null,
  );

  let vulnSuffix = '';
  if (topVuln) {
    const hopWord = topVuln.hopCount === 1 ? '1 hop' : `${topVuln.hopCount} hops`;
    vulnSuffix = `  ${dim}→${reset} ${violet}${topVuln.packageName}${reset} ${dim}${topVuln.cveId}${reset} ${dim}(${hopWord})${reset}`;
    if (entry.vulnerableDeps.length > 1) {
      vulnSuffix += `  ${dim}+${entry.vulnerableDeps.length - 1} more${reset}`;
    }
  }

  console.log(
    `  ${routeColor}[${riskLabel}]${reset} ${bold}${entry.route.padEnd(30)}${reset}  ${exposureBadge}${vulnSuffix}`,
  );

  // Pattern matches below the route line
  for (const pm of entry.patternMatches) {
    const sevUpper = pm.severity.toUpperCase();
    const pmColor = pm.severity === 'critical' ? red : pm.severity === 'high' ? yellow : dim;
    console.log(
      `        ${pmColor}⚠ [${sevUpper}]${reset} ${dim}${pm.patternId}${reset} ${dim}at${reset} ${pm.symbolName}:${pm.line}`,
    );
  }
}
