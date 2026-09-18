import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from '../../config';
import { dim, reset, violet, bold, green } from '../ui';
import { formatFixSuggestion } from '../../security/export/fix-suggestions';
import { SuppressionManager } from '../../security/suppressions';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse an `epss=N` fail-on value and return the threshold, or null if not an epss condition. */
function parseEpssFailOn(failOn: string): number | null {
  const m = failOn.match(/^epss=(.+)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

/** Extract workspace label from a source_manifests JSON string. */
function workspaceFromManifests(sourceManifests: string | null): string {
  if (!sourceManifests) return 'root';
  try {
    const manifests: string[] = JSON.parse(sourceManifests);
    if (!manifests.length) return 'root';
    const dir = path.dirname(manifests[0]);
    return dir === '.' ? 'root' : dir;
  } catch {
    return 'root';
  }
}

export function register(program: Command): void {
  program
    .command('vulns [projectPath]')
    .description('List vulnerabilities with reachability verdicts and severity')
    .option('--severity <level>', 'Filter by severity: critical, high, medium, low')
    .option('--verdict <verdict>', 'Filter by verdict: affected, not_affected, under_investigation')
    .option('--refresh', 'Trigger fresh vulnerability enrichment before listing')
    .option('--epss <threshold>', 'Filter by EPSS score (e.g. 0.5 shows only vulns with EPSS >= 0.5)')
    .option('--stale', 'Show staleness score of the affected dependency alongside each CVE')
    .option('--sort <key>', 'Sort results by: risk (default), cvss, epss, name')
    .option('--add <cveId>', 'Manually register a CVE')
    .option('--package <name>', 'Package name for --add')
    .option('--version <ver>', 'Package version for --add')
    .option('--fail-on <condition>', 'Exit 1 if condition is met: affected, any, critical, high, epss=N')
    .option('--group-by <key>', 'Group output by: workspace')
    .action(async (projectPath: string | undefined, opts: {
      severity?: string;
      verdict?: string;
      refresh?: boolean;
      epss?: string;
      stale?: boolean;
      sort?: string;
      add?: string;
      package?: string;
      version?: string;
      failOn?: string;
      groupBy?: string;
    }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const config = await loadConfig(target);

      if (!config.enableSecurity) {
        console.error(`\n  ${'\x1b[33m'}⚠ Security analysis is disabled.${reset}`);
        console.error(`  ${dim}Enable it in .kirograph/config.json:${reset} ${violet}${bold}"enableSecurity": true${reset}`);
        console.error(`  ${dim}Then re-run:${reset} ${violet}${bold}kirograph index${reset}\n`);
        process.exit(1);
      }

      // Validate --fail-on early
      if (opts.failOn !== undefined) {
        const validFailOns = ['affected', 'any', 'critical', 'high'];
        const isEpss = parseEpssFailOn(opts.failOn) !== null;
        if (!validFailOns.includes(opts.failOn) && !isEpss) {
          console.error(`  ✖ Invalid --fail-on value: ${opts.failOn}. Use: affected, any, critical, high, epss=N`);
          process.exit(1);
        }
      }

      // Validate --group-by early
      if (opts.groupBy !== undefined && opts.groupBy !== 'workspace') {
        console.error(`  ✖ Invalid --group-by value: ${opts.groupBy}. Supported: workspace`);
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
      const rawDb = db.getRawDb();

      // Handle --add: manually register a CVE
      if (opts.add) {
        if (!opts.package || !opts.version) {
          console.error(`  ✖ --add requires --package <name> and --version <ver>`);
          cg.close(); process.exit(1);
        }

        const cveId = opts.add;
        const pkgName = opts.package;
        const pkgVersion = opts.version;

        // Find the matching dependency node
        const depRow: { node_id: string; ecosystem: string } | undefined = rawDb.get(
          `SELECT node_id, ecosystem FROM sec_dependencies
           WHERE package_name = ? AND (resolved_version = ? OR declared_constraint = ?)`,
          [pkgName, pkgVersion, pkgVersion],
        );

        if (!depRow) {
          console.error(`  ✖ No dependency found matching ${violet}${pkgName}@${pkgVersion}${reset}`);
          console.error(`  ${dim}Run${reset} ${violet}${bold}kirograph index${reset} ${dim}first to discover dependencies.${reset}`);
          cg.close(); process.exit(1);
        }

        // Create the vulnerability node
        const vulnNodeId = `vuln:${cveId}`;
        const now = Date.now();

        rawDb.run(
          `INSERT OR REPLACE INTO nodes
            (id, kind, name, qualified_name, file_path, language,
             start_line, end_line, start_column, end_column,
             is_exported, is_async, is_static, is_abstract, updated_at)
           VALUES (?, 'vulnerability', ?, ?, '', 'unknown', 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
          [vulnNodeId, cveId, cveId, now],
        );

        rawDb.run(
          `INSERT OR REPLACE INTO sec_vulnerabilities
            (node_id, cve_id, severity_score, affected_ranges, fixed_version, summary, source_database)
           VALUES (?, ?, NULL, '[]', NULL, 'Manually registered', 'manual')`,
          [vulnNodeId, cveId],
        );

        // Create has_vulnerability edge
        rawDb.run(
          `INSERT OR IGNORE INTO edges (source, target, kind, confidence, confidence_score)
           VALUES (?, ?, 'has_vulnerability', 'extracted', 1.0)`,
          [depRow.node_id, vulnNodeId],
        );

        console.log(`  ${green}✓${reset} Registered ${violet}${bold}${cveId}${reset} against ${violet}${pkgName}@${pkgVersion}${reset}`);
        cg.close();
        return;
      }

      // Handle --refresh: trigger fresh vulnerability enrichment
      if (opts.refresh) {
        console.error(`  ${dim}Refreshing vulnerability data from configured databases...${reset}`);
        const { OsvAdapter } = await import('../../security/vuln/osv-adapter');
        const { VulnerabilityDatabaseClient } = await import('../../security/vuln/client');

        const adapters = config.securityDatabases.map((dbName: string) => {
          if (dbName.toUpperCase() === 'OSV') return new OsvAdapter();
          return null;
        }).filter(Boolean) as any[];

        const client = new VulnerabilityDatabaseClient(adapters, db);
        const result = await client.enrichAll();

        console.error(`  ${green}✓${reset} Checked ${bold}${result.dependenciesChecked}${reset} dependencies, found ${bold}${result.vulnerabilitiesFound}${reset} vulnerabilities`);
        if (result.errors.length > 0) {
          console.error(`  ${'\x1b[33m'}⚠${reset} ${result.errors.length} error(s) during enrichment`);
        }
        console.error();
      }

      // Build query for listing vulnerabilities
      // Include source_manifests when group-by workspace is requested
      const selectSourceManifests = opts.groupBy === 'workspace' ? `,\n          d.source_manifests` : '';
      let query = `
        SELECT
          v.node_id, v.cve_id, v.severity_score, v.fixed_version, v.summary, v.source_database,
          v.epss_score, v.epss_percentile, v.risk_score,
          d.package_name, d.ecosystem, d.resolved_version, d.declared_constraint,
          d.staleness_score,
          r.verdict${selectSourceManifests}
        FROM sec_vulnerabilities v
        LEFT JOIN edges e ON e.target = v.node_id AND e.kind = 'has_vulnerability'
        LEFT JOIN sec_dependencies d ON d.node_id = e.source
        LEFT JOIN sec_reachability r ON r.vulnerability_node_id = v.node_id
        WHERE 1=1
      `;
      const params: any[] = [];

      // Apply severity filter.
      // Bounds are half-open [min, max) and MUST mirror the display buckets in
      // printVulnRow() so the filter and the rendered label never disagree:
      //   CRITICAL >= 9.0, HIGH >= 7.0, MEDIUM >= 4.0, LOW < 4.0 (incl. 0.0).
      if (opts.severity) {
        const severityRanges: Record<string, [number, number]> = {
          critical: [9.0, 10.01],
          high: [7.0, 9.0],
          medium: [4.0, 7.0],
          low: [0.0, 4.0],
        };
        const range = severityRanges[opts.severity.toLowerCase()];
        if (!range) {
          console.error(`  ✖ Invalid severity: ${opts.severity}. Use: critical, high, medium, low`);
          cg.close(); process.exit(1);
        }
        // severity_score IS NULL means "unknown" — excluded from every band.
        query += ` AND v.severity_score IS NOT NULL AND v.severity_score >= ? AND v.severity_score < ?`;
        params.push(range[0], range[1]);
      }

      // Apply verdict filter
      if (opts.verdict) {
        const validVerdicts = ['affected', 'not_affected', 'under_investigation'];
        if (!validVerdicts.includes(opts.verdict)) {
          console.error(`  ✖ Invalid verdict: ${opts.verdict}. Use: affected, not_affected, under_investigation`);
          cg.close(); process.exit(1);
        }
        query += ` AND r.verdict = ?`;
        params.push(opts.verdict);
      }

      // Apply EPSS threshold filter
      if (opts.epss !== undefined) {
        const epssThreshold = parseFloat(opts.epss);
        if (isNaN(epssThreshold) || epssThreshold < 0 || epssThreshold > 1) {
          console.error(`  ✖ Invalid EPSS threshold: ${opts.epss}. Use a number between 0 and 1 (e.g. 0.5)`);
          cg.close(); process.exit(1);
        }
        query += ` AND v.epss_score >= ?`;
        params.push(epssThreshold);
      }

      // Resolve sort order
      const sortKey = opts.sort?.toLowerCase() ?? 'risk';
      const validSortKeys = ['risk', 'cvss', 'epss', 'name'];
      if (!validSortKeys.includes(sortKey)) {
        console.error(`  ✖ Invalid sort key: ${opts.sort}. Use: risk, cvss, epss, name`);
        cg.close(); process.exit(1);
      }
      const sortClause =
        sortKey === 'risk' ? `v.risk_score DESC NULLS LAST` :
        sortKey === 'cvss' ? `v.severity_score DESC NULLS LAST` :
        sortKey === 'epss' ? `v.epss_score DESC NULLS LAST` :
        `v.cve_id ASC`;
      query += ` ORDER BY ${sortClause}`;

      const rows: Array<{
        node_id: string;
        cve_id: string;
        severity_score: number | null;
        fixed_version: string | null;
        summary: string | null;
        source_database: string;
        epss_score: number | null;
        epss_percentile: number | null;
        risk_score: number | null;
        package_name: string | null;
        ecosystem: string | null;
        resolved_version: string | null;
        declared_constraint: string | null;
        staleness_score: number | null;
        verdict: string | null;
        source_manifests?: string | null;
      }> = rawDb.all(query, params);

      // Deduplicate by (cve_id, package_name, ecosystem) — same CVE can appear multiple
      // times if a package is declared in multiple manifests (monorepo) or has multiple
      // dep nodes. Keep the row with the worst verdict (affected > under_investigation > not_affected > null).
      const verdictRank = (v: string | null) =>
        v === 'affected' ? 3 : v === 'under_investigation' ? 2 : v === 'not_affected' ? 1 : 0;
      const deduped = new Map<string, typeof rows[0]>();
      for (const row of rows) {
        const key = `${row.cve_id}::${row.package_name ?? ''}::${row.ecosystem ?? ''}`;
        const existing = deduped.get(key);
        if (!existing || verdictRank(row.verdict) > verdictRank(existing.verdict)) {
          deduped.set(key, row);
        }
      }
      const dedupedRows = [...deduped.values()];

      // Filter out suppressed CVEs
      const suppressions = new SuppressionManager(target);
      const suppressedRows = dedupedRows.filter(row => suppressions.isSuppressed(row.cve_id));
      const filteredRows = dedupedRows.filter(row => !suppressions.isSuppressed(row.cve_id));

      if (filteredRows.length === 0) {
        const filterNote = (opts.severity || opts.verdict)
          ? ` matching filters`
          : '';
        console.log(`\n  ${dim}No vulnerabilities found${filterNote}.${reset}\n`);
        if (suppressedRows.length > 0) {
          console.log(`  ${dim}${suppressedRows.length} CVE(s) suppressed — kirograph vuln suppressions to review${reset}\n`);
        }
        cg.close();
        return;
      }

      // ── Render a single vulnerability row ────────────────────────────────────

      function printVulnRow(row: (typeof filteredRows)[0], indent = '  '): void {
        // Severity badge
        const score = row.severity_score;
        let severityLabel: string;
        let severityColor: string;
        if (score == null) {
          severityLabel = 'unknown';
          severityColor = dim;
        } else if (score >= 9.0) {
          severityLabel = 'CRITICAL';
          severityColor = '\x1b[31m';
        } else if (score >= 7.0) {
          severityLabel = 'HIGH';
          severityColor = '\x1b[31m';
        } else if (score >= 4.0) {
          severityLabel = 'MEDIUM';
          severityColor = '\x1b[33m';
        } else {
          severityLabel = 'LOW';
          severityColor = dim;
        }

        // Verdict badge
        let verdictLabel: string;
        let verdictColor: string;
        if (!row.verdict) {
          verdictLabel = 'pending';
          verdictColor = dim;
        } else if (row.verdict === 'affected') {
          verdictLabel = 'affected';
          verdictColor = '\x1b[31m';
        } else if (row.verdict === 'not_affected') {
          verdictLabel = 'not affected';
          verdictColor = green;
        } else {
          verdictLabel = 'investigating';
          verdictColor = '\x1b[33m';
        }

        const pkg = row.package_name
          ? `${row.package_name}@${row.resolved_version || row.declared_constraint || '?'}`
          : 'unknown package';

        // EPSS badge
        let epssBadge = '';
        if (row.epss_score != null && row.epss_percentile != null) {
          const epssColor = row.epss_score >= 0.3 ? '\x1b[33m' : dim;
          const scoreStr = row.epss_score.toFixed(2);
          const pctStr = `${Math.round(row.epss_percentile * 100)}th%`;
          epssBadge = `  ${epssColor}${dim}[EPSS: ${scoreStr} / ${pctStr}]${reset}`;
        }

        // Risk score badge
        let riskBadge = '';
        if (row.risk_score != null) {
          const riskColor = row.risk_score >= 7 ? '\x1b[31m' : row.risk_score >= 4 ? '\x1b[33m' : dim;
          riskBadge = `  ${riskColor}[Risk: ${row.risk_score.toFixed(1)}]${reset}`;
        }

        console.log(`${indent}${severityColor}${severityLabel}${reset}  ${violet}${bold}${row.cve_id}${reset}  ${dim}${pkg}${reset}  [${verdictColor}${verdictLabel}${reset}]${epssBadge}${riskBadge}`);

        if (row.summary && row.summary !== 'Manually registered') {
          const truncated = row.summary.length > 100 ? row.summary.slice(0, 100) + '…' : row.summary;
          console.log(`${indent}  ${dim}${truncated}${reset}`);
        }

        // Staleness badge (when --stale flag is set)
        if (opts.stale && row.staleness_score != null) {
          const s = row.staleness_score;
          const staleColor = s >= 0.7 ? '\x1b[31m' : s >= 0.4 ? '\x1b[33m' : dim;
          console.log(`${indent}  ${staleColor}${dim}[staleness: ${s.toFixed(2)}]${reset}`);
        }

        // Fix suggestion
        if (row.fixed_version && row.ecosystem && row.package_name) {
          const fix = formatFixSuggestion(row.ecosystem, row.package_name, row.fixed_version);
          if (fix) {
            console.log(`${indent}  ${fix}`);
          }
        }

        console.log();
      }

      // ── Output: grouped or flat ───────────────────────────────────────────────

      if (opts.groupBy === 'workspace') {
        // Group by workspace (directory of first source manifest)
        const groups = new Map<string, Array<(typeof filteredRows)[0]>>();
        for (const row of filteredRows) {
          const ws = workspaceFromManifests(row.source_manifests ?? null);
          if (!groups.has(ws)) groups.set(ws, []);
          groups.get(ws)!.push(row);
        }

        // Only apply workspace grouping when there are multiple distinct workspaces
        const workspaces = Array.from(groups.keys());
        if (workspaces.length <= 1) {
          // Single workspace — fall through to flat output
          console.log(`\n  ${bold}Vulnerabilities${reset} (${filteredRows.length})\n`);
          for (const row of filteredRows) {
            printVulnRow(row);
          }
        } else {
          console.log(`\n  ${bold}Vulnerabilities${reset} (${filteredRows.length})\n`);
          for (const ws of workspaces) {
            const wsRows = groups.get(ws)!;
            const count = wsRows.length;
            const header = `Workspace: ${ws} (${count} vulnerabilit${count === 1 ? 'y' : 'ies'})`;
            const line = '─'.repeat(header.length);
            console.log(`  ${bold}${header}${reset}`);
            console.log(`  ${dim}${line}${reset}`);
            for (const row of wsRows) {
              printVulnRow(row);
            }
          }
        }
      } else {
        console.log(`\n  ${bold}Vulnerabilities${reset} (${filteredRows.length})\n`);
        for (const row of filteredRows) {
          printVulnRow(row);
        }
      }

      if (suppressedRows.length > 0) {
        console.log(`  ${dim}${suppressedRows.length} CVE(s) suppressed — kirograph vuln suppressions to review${reset}\n`);
      }

      // Hint when reachability hasn't been computed yet (verdict is pending).
      // vulns --refresh only re-queries vulnerability data; the call-graph
      // reachability analysis that resolves [pending] → [affected]/[not affected]
      // runs during `kirograph index`.
      const pendingCount = filteredRows.filter(r => !r.verdict).length;
      if (pendingCount > 0) {
        console.log(`  ${dim}${pendingCount} vulnerabilit${pendingCount === 1 ? 'y is' : 'ies are'} [pending] reachability analysis — run ${reset}kirograph index${dim} to compute call-graph verdicts.${reset}\n`);
      }

      // ── CI exit codes: --fail-on ──────────────────────────────────────────────

      if (opts.failOn !== undefined) {
        const failOn = opts.failOn;

        let failCount = 0;
        let failReason = '';

        if (failOn === 'affected') {
          failCount = filteredRows.filter(r => r.verdict === 'affected').length;
          failReason = `affected`;
        } else if (failOn === 'any') {
          failCount = filteredRows.length;
          failReason = `any`;
        } else if (failOn === 'critical') {
          failCount = filteredRows.filter(r => r.severity_score != null && r.severity_score >= 9.0).length;
          failReason = `critical`;
        } else if (failOn === 'high') {
          failCount = filteredRows.filter(r => r.severity_score != null && r.severity_score >= 7.0).length;
          failReason = `high`;
        } else {
          const epssThreshold = parseEpssFailOn(failOn);
          if (epssThreshold !== null) {
            failCount = filteredRows.filter(r => r.epss_score != null && r.epss_score >= epssThreshold).length;
            failReason = `epss=${epssThreshold}`;
          }
        }

        if (failCount > 0) {
          console.log(`  \x1b[31m✖\x1b[0m --fail-on ${failReason}: ${failCount} ${failReason === 'any' ? '' : `${failReason} `}vulnerabilit${failCount === 1 ? 'y' : 'ies'} found. Exiting with code 1.`);
          cg.close();
          process.exit(1);
        }
      }

      cg.close();
    });
}
