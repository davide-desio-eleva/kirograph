import KiroGraph from '../../index';
import { clampLimit, truncate } from './utils';

export async function handleSecurity(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_security': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';
      if (!config.enableArchitecture) return 'Security requires architecture analysis. Set enableArchitecture: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      const depCount: { count: number } = rawDb.get(
        `SELECT COUNT(*) as count FROM sec_dependencies`,
      ) ?? { count: 0 };

      const vulnCount: { count: number } = rawDb.get(
        `SELECT COUNT(*) as count FROM sec_vulnerabilities`,
      ) ?? { count: 0 };

      const verdictRows: Array<{ verdict: string; count: number }> = rawDb.all(
        `SELECT verdict, COUNT(*) as count FROM sec_reachability GROUP BY verdict`,
      );
      const verdicts: Record<string, number> = {};
      for (const row of verdictRows) {
        verdicts[row.verdict] = row.count;
      }

      const staleCount: { count: number } = rawDb.get(
        `SELECT COUNT(*) as count FROM sec_dependencies WHERE vuln_data_stale = 1`,
      ) ?? { count: 0 };

      // Count suppressed CVEs
      const { SuppressionManager: SecSuppressionManager } = await import('../../security/suppressions');
      const secSuppressions = new SecSuppressionManager(projectRoot);
      const allCveIds: Array<{ cve_id: string }> = rawDb.all(`SELECT cve_id FROM sec_vulnerabilities`);
      const suppressedCveCount = allCveIds.filter(r => secSuppressions.isSuppressed(r.cve_id)).length;
      const visibleVulnCount = vulnCount.count - suppressedCveCount;

      const lines: string[] = [
        '# Security Overview',
        '',
        `Dependencies: ${depCount.count}`,
        `Vulnerabilities: ${visibleVulnCount}${suppressedCveCount > 0 ? ` (${suppressedCveCount} suppressed)` : ''}`,
      ];

      if (visibleVulnCount > 0) {
        const affected = verdicts['affected'] ?? 0;
        const notAffected = verdicts['not_affected'] ?? 0;
        const underInvestigation = verdicts['under_investigation'] ?? 0;
        const pending = visibleVulnCount - affected - notAffected - underInvestigation;

        lines.push('', '## Reachability Verdicts', '');
        if (affected > 0) lines.push(`● Affected: ${affected}`);
        if (notAffected > 0) lines.push(`● Not affected: ${notAffected}`);
        if (underInvestigation > 0) lines.push(`● Under investigation: ${underInvestigation}`);
        if (pending > 0) lines.push(`● Pending analysis: ${pending}`);
      }

      if (staleCount.count > 0) {
        lines.push('', `⚠ ${staleCount.count} dependenc${staleCount.count === 1 ? 'y has' : 'ies have'} stale vulnerability data. Use kirograph_vulns with refresh=true to update.`);
      }

      // Check if vulnerability data is stale by age
      const lastVulnCheck = (rawDb.get(
        `SELECT MIN(last_vuln_check) as oldest FROM sec_dependencies WHERE last_vuln_check IS NOT NULL`,
      ) as { oldest: number | null } | undefined)?.oldest;
      if (lastVulnCheck != null) {
        const ageMs = Date.now() - lastVulnCheck;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const maxAge = config.securityEnrichMaxAgeDays ?? 7;
        if (ageDays > maxAge) {
          lines.push('', `⚠ Vulnerability data is ${Math.floor(ageDays)} days old (max: ${maxAge}). Run kirograph vulns --refresh to update.`);
        }
      }

      // Pattern SAST findings count
      try {
        const rawDbSec = db.getRawDb();
        const tableExistsSec = rawDbSec.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
        if (tableExistsSec) {
          const patternCount = rawDbSec.get('SELECT COUNT(*) as cnt FROM pattern_matches')?.cnt ?? 0;
          if (patternCount > 0) {
            const critCount = rawDbSec.get("SELECT COUNT(*) as cnt FROM pattern_matches WHERE severity = 'critical'")?.cnt ?? 0;
            lines.push(`SAST findings: ${patternCount} pattern matches (${critCount} critical)`);
          }
        }
      } catch { /* non-critical */ }

      return lines.join('\n');
    }

    case 'kirograph_vulns': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      // Handle refresh
      if (args.refresh === true) {
        const { OsvAdapter } = await import('../../security/vuln/osv-adapter');
        const { VulnerabilityDatabaseClient } = await import('../../security/vuln/client');

        const adapters = config.securityDatabases.map((dbName: string) => {
          if (dbName.toUpperCase() === 'OSV') return new OsvAdapter();
          return null;
        }).filter(Boolean) as any[];

        const client = new VulnerabilityDatabaseClient(adapters, db);
        await client.enrichAll();
      }

      // Build query
      let query = `
        SELECT
          v.node_id, v.cve_id, v.severity_score, v.fixed_version, v.summary,
          v.epss_score, v.epss_percentile, v.risk_score,
          d.package_name, d.ecosystem, d.resolved_version, d.declared_constraint,
          r.verdict
        FROM sec_vulnerabilities v
        LEFT JOIN edges e ON e.target = v.node_id AND e.kind = 'has_vulnerability'
        LEFT JOIN sec_dependencies d ON d.node_id = e.source
        LEFT JOIN sec_reachability r ON r.vulnerability_node_id = v.node_id
        WHERE 1=1
      `;
      const params: any[] = [];

      // Severity filter
      if (args.severity) {
        const severityRanges: Record<string, [number, number]> = {
          critical: [9.0, 10.0],
          high: [7.0, 8.9],
          medium: [4.0, 6.9],
          low: [0.1, 3.9],
        };
        const range = severityRanges[(args.severity as string).toLowerCase()];
        if (!range) return `Invalid severity: ${args.severity}. Use: critical, high, medium, low`;
        query += ` AND v.severity_score >= ? AND v.severity_score <= ?`;
        params.push(range[0], range[1]);
      }

      // Verdict filter
      if (args.verdict) {
        const validVerdicts = ['affected', 'not_affected', 'under_investigation'];
        if (!validVerdicts.includes(args.verdict as string)) {
          return `Invalid verdict: ${args.verdict}. Use: affected, not_affected, under_investigation`;
        }
        query += ` AND r.verdict = ?`;
        params.push(args.verdict);
      }

      const limit = clampLimit(args.limit as number | undefined, 20);
      query += ` ORDER BY v.risk_score DESC NULLS LAST LIMIT ?`;
      params.push(limit);

      const rows: Array<{
        node_id: string;
        cve_id: string;
        severity_score: number | null;
        fixed_version: string | null;
        summary: string | null;
        epss_score: number | null;
        epss_percentile: number | null;
        risk_score: number | null;
        package_name: string | null;
        ecosystem: string | null;
        resolved_version: string | null;
        declared_constraint: string | null;
        verdict: string | null;
      }> = rawDb.all(query, params);

      // Deduplicate by (cve_id, package_name, ecosystem) — same CVE can appear multiple
      // times when a package is declared in multiple manifests (monorepo).
      const verdictRankMcp = (v: string | null) =>
        v === 'affected' ? 3 : v === 'under_investigation' ? 2 : v === 'not_affected' ? 1 : 0;
      const dedupMapMcp = new Map<string, typeof rows[0]>();
      for (const row of rows) {
        const key = `${row.cve_id}::${row.package_name ?? ''}::${row.ecosystem ?? ''}`;
        const ex = dedupMapMcp.get(key);
        if (!ex || verdictRankMcp(row.verdict) > verdictRankMcp(ex.verdict)) dedupMapMcp.set(key, row);
      }
      const dedupedRowsMcp = [...dedupMapMcp.values()];

      // Filter out suppressed CVEs
      const { SuppressionManager } = await import('../../security/suppressions');
      const suppressionMgr = new SuppressionManager(projectRoot);
      const suppressedCount = dedupedRowsMcp.filter(row => suppressionMgr.isSuppressed(row.cve_id)).length;
      const filteredRows = dedupedRowsMcp.filter(row => !suppressionMgr.isSuppressed(row.cve_id));

      if (filteredRows.length === 0) {
        const noMatch = 'No vulnerabilities found' + ((args.severity || args.verdict) ? ' matching filters.' : '.');
        return suppressedCount > 0 ? `${noMatch} (${suppressedCount} suppressed)` : noMatch;
      }

      const { formatFixSuggestion } = await import('../../security/export/fix-suggestions');

      const lines: string[] = [`Vulnerabilities (${filteredRows.length}${suppressedCount > 0 ? `, ${suppressedCount} suppressed` : ''}):\n`];

      for (const row of filteredRows) {
        const score = row.severity_score;
        let severityLabel: string;
        if (score == null) severityLabel = 'UNKNOWN';
        else if (score >= 9.0) severityLabel = 'CRITICAL';
        else if (score >= 7.0) severityLabel = 'HIGH';
        else if (score >= 4.0) severityLabel = 'MEDIUM';
        else severityLabel = 'LOW';

        let verdictLabel: string;
        if (!row.verdict) verdictLabel = 'pending';
        else if (row.verdict === 'affected') verdictLabel = 'affected';
        else if (row.verdict === 'not_affected') verdictLabel = 'not affected';
        else verdictLabel = 'investigating';

        const pkg = row.package_name
          ? `${row.package_name}@${row.resolved_version || row.declared_constraint || '?'}`
          : 'unknown package';

        const epssNote = row.epss_score != null
          ? ` [EPSS: ${row.epss_score.toFixed(2)}]`
          : '';
        const riskNote = row.risk_score != null
          ? ` [Risk: ${row.risk_score.toFixed(1)}]`
          : '';
        lines.push(`${severityLabel}  ${row.cve_id}  ${pkg}  [${verdictLabel}]${epssNote}${riskNote}`);

        if (row.summary && row.summary !== 'Manually registered') {
          const truncSummary = row.summary.length > 120 ? row.summary.slice(0, 120) + '…' : row.summary;
          lines.push(`  ${truncSummary}`);
        }

        if (row.fixed_version && row.ecosystem && row.package_name) {
          const fix = formatFixSuggestion(row.ecosystem, row.package_name, row.fixed_version);
          if (fix) lines.push(`  ${fix}`);
        }
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_vuln_add': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const cveId = args.cveId as string;
      const pkgName = args.package as string;
      if (!cveId) return 'Error: cveId is required.';
      if (!pkgName) return 'Error: package is required.';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      // Find matching Dependency_Node
      const depRow: { node_id: string; ecosystem: string } | undefined = rawDb.get(
        `SELECT node_id, ecosystem FROM sec_dependencies WHERE package_name = ?`,
        [pkgName],
      );

      if (!depRow) {
        return `No dependency found matching "${pkgName}". Run kirograph index first to discover dependencies.`;
      }

      // Create Vulnerability_Node
      const vulnNodeId = `vuln:${cveId}`;
      const now = Date.now();
      const severity = args.severity as number | undefined;
      const summary = (args.summary as string) ?? 'Manually registered';
      const fixedVersion = (args.fixedVersion as string) ?? null;

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
         VALUES (?, ?, ?, '[]', ?, ?, 'manual')`,
        [vulnNodeId, cveId, severity ?? null, fixedVersion, summary],
      );

      // Create has_vulnerability edge
      rawDb.run(
        `INSERT OR IGNORE INTO edges (source, target, kind, confidence, confidence_score)
         VALUES (?, ?, 'has_vulnerability', 'extracted', 1.0)`,
        [depRow.node_id, vulnNodeId],
      );

      return `Registered ${cveId} against ${pkgName}.`;
    }

    case 'kirograph_vuln_suppress': {
      const projectRoot = cg.getProjectRoot();
      const cveId = args.cveId as string;
      if (!cveId) return 'Error: cveId is required.';

      const { SuppressionManager } = await import('../../security/suppressions');
      const manager = new SuppressionManager(projectRoot);
      manager.add(cveId, args.reason as string | undefined, args.expires as string | undefined);

      const reasonNote = args.reason ? ` Reason: ${args.reason}.` : '';
      const expiresNote = args.expires ? ` Expires: ${args.expires}.` : '';
      return `${cveId} suppressed.${reasonNote}${expiresNote}`;
    }

    case 'kirograph_sbom': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { SBOMExporter } = await import('../../security/export/sbom');
      const exporter = new SBOMExporter(db, projectRoot);
      const json = exporter.exportJSON();

      return truncate(json);
    }

    case 'kirograph_vex': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { VEXExporter } = await import('../../security/export/vex');
      const exporter = new VEXExporter(db, projectRoot);
      const json = exporter.exportJSON();

      return truncate(json);
    }

    case 'kirograph_reachability': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const target = args.target as string;
      if (!target) return 'Error: target is required (dependency name or CVE ID).';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      // Try to find target as a CVE ID in sec_vulnerabilities
      let vulnerabilityNodeId: string | null = null;
      let targetLabel = target;

      const vulnRow: { node_id: string } | undefined = rawDb.get(
        `SELECT node_id FROM sec_vulnerabilities WHERE cve_id = ?`,
        [target],
      );

      if (vulnRow) {
        vulnerabilityNodeId = vulnRow.node_id;
      } else {
        // Try to find target as a dependency name
        const depRow: { node_id: string; package_name: string } | undefined = rawDb.get(
          `SELECT node_id, package_name FROM sec_dependencies WHERE package_name = ?`,
          [target],
        );

        if (depRow) {
          targetLabel = depRow.package_name;
          // Find vulnerabilities linked to this dependency
          const vulnEdge: { target: string } | undefined = rawDb.get(
            `SELECT target FROM edges WHERE source = ? AND kind = 'has_vulnerability' LIMIT 1`,
            [depRow.node_id],
          );

          if (vulnEdge) {
            vulnerabilityNodeId = vulnEdge.target;
          } else {
            return `No vulnerabilities found for dependency "${target}". The dependency exists but has no known vulnerabilities.`;
          }
        } else {
          return `Target "${target}" not found. Provide a valid CVE ID or dependency package name.`;
        }
      }

      // Run reachability analysis
      const { ReachabilityAnalyzer } = await import('../../security/reachability');
      const analyzer = new ReachabilityAnalyzer(db, config);
      const result = await analyzer.analyze(vulnerabilityNodeId);

      const lines: string[] = [
        `# Reachability: ${targetLabel}`,
        '',
        `Verdict: ${result.verdict}`,
        `Reaching entry points: ${result.reachingEntryPointCount}`,
      ];

      if (result.paths.length > 0) {
        lines.push('', '## Paths');
        for (const p of result.paths.slice(0, 5)) {
          lines.push(`- From ${p.entryPoint}: ${p.path.join(' → ')}`);
        }
        if (result.paths.length > 5) {
          lines.push(`  …and ${result.paths.length - 5} more paths`);
        }
      }

      if (result.unresolvedSymbols.length > 0) {
        lines.push('', '## Unresolved Symbols');
        for (const sym of result.unresolvedSymbols.slice(0, 10)) {
          lines.push(`- ${sym}`);
        }
        if (result.unresolvedSymbols.length > 10) {
          lines.push(`  …and ${result.unresolvedSymbols.length - 10} more`);
        }
      }

      // Get impact summary if affected
      if (result.verdict === 'affected') {
        const impact = await analyzer.getImpactSummary(vulnerabilityNodeId);
        if (impact) {
          lines.push('', '## Impact Summary');
          if (impact.affectedLayers.length > 0) {
            lines.push(`Affected layers: ${impact.affectedLayers.join(', ')}`);
          }
          lines.push(`Affected entry points: ${impact.affectedEntryPoints.length}`);
          lines.push(`Distinct paths: ${impact.distinctPathCount}`);
        }
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_staleness': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      const threshold = typeof args.threshold === 'number' ? args.threshold : 0.3;

      // Optionally refresh staleness data from registries
      if (args.refresh === true) {
        const { StalenessChecker } = await import('../../security/staleness');
        const checker = new StalenessChecker(db);
        await checker.checkAll();
      }

      const rows: Array<{
        package_name: string;
        ecosystem: string;
        resolved_version: string | null;
        declared_constraint: string;
        latest_version: string | null;
        latest_published: number | null;
        staleness_score: number | null;
      }> = rawDb.all(
        `SELECT package_name, ecosystem, resolved_version, declared_constraint,
                latest_version, latest_published, staleness_score
         FROM sec_dependencies
         WHERE staleness_score >= ?
         ORDER BY staleness_score DESC`,
        [threshold],
      );

      if (rows.length === 0) {
        return `No dependencies found with staleness_score >= ${threshold}.` +
          (args.refresh ? '' : ' Use refresh=true to fetch latest version data from registries.');
      }

      const lines: string[] = [`Stale Dependencies (threshold: ${threshold}):\n`];
      for (const row of rows) {
        const resolved = row.resolved_version ?? row.declared_constraint ?? '?';
        const latest = row.latest_version ?? '?';
        const score = row.staleness_score ?? 0;
        const months = row.latest_published
          ? Math.round((Date.now() - row.latest_published) / (1000 * 60 * 60 * 24 * 30))
          : null;
        const bar = '█'.repeat(Math.round(score * 10)) + '░'.repeat(10 - Math.round(score * 10));
        const monthsStr = months !== null ? `, ${months}mo since latest` : '';
        lines.push(`${row.package_name} (${row.ecosystem}): ${resolved} → ${latest}${monthsStr}`);
        lines.push(`  ${bar} ${score.toFixed(2)}`);
      }

      const totalCount: { count: number } = rawDb.get(`SELECT COUNT(*) as count FROM sec_dependencies`) ?? { count: 0 };
      lines.push('', `${rows.length} of ${totalCount.count} dependencies are stale (score >= ${threshold})`);

      return truncate(lines.join('\n'));
    }

    case 'kirograph_licenses': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();
      const rawDb = db.getRawDb();

      const deps: Array<{
        package_name: string;
        ecosystem: string;
        license: string | null;
      }> = rawDb.all(
        `SELECT package_name, ecosystem, license FROM sec_dependencies ORDER BY ecosystem, package_name`,
      );

      const { checkLicensePolicy } = await import('../../security/license');
      const policy = config.securityLicensePolicy;
      const violations = checkLicensePolicy(deps, policy);

      if (args.policy === true) {
        // Return only violations
        if (violations.length === 0) {
          return 'No license policy violations found.';
        }
        const lines: string[] = ['# License Policy Violations\n'];
        for (const v of violations) {
          lines.push(`${v.severity.toUpperCase()}  ${v.packageName} [${v.ecosystem}]  ${v.license}`);
        }
        const denyCount = violations.filter(v => v.severity === 'deny').length;
        const warnCount = violations.filter(v => v.severity === 'warn').length;
        lines.push('');
        if (denyCount > 0) lines.push(`${denyCount} denied license${denyCount !== 1 ? 's' : ''}`);
        if (warnCount > 0) lines.push(`${warnCount} license warning${warnCount !== 1 ? 's' : ''}`);
        return truncate(lines.join('\n'));
      }

      // Full listing
      if (deps.length === 0) {
        return 'No dependencies found. Run kirograph index first.';
      }

      const violationMap = new Map<string, 'deny' | 'warn'>();
      for (const v of violations) {
        violationMap.set(`${v.ecosystem}:${v.packageName}`, v.severity);
      }

      const lines: string[] = [`# License Report (${deps.length} dependencies)\n`];

      // Violations first
      if (violations.length > 0) {
        lines.push('## Policy Violations\n');
        for (const v of violations) {
          lines.push(`${v.severity.toUpperCase()}  ${v.packageName} [${v.ecosystem}]  ${v.license}`);
        }
        lines.push('');
      }

      lines.push('## All Dependencies\n');
      lines.push('package | ecosystem | license | status');
      lines.push('------- | --------- | ------- | ------');

      for (const dep of deps) {
        const key = `${dep.ecosystem}:${dep.package_name}`;
        const violation = violationMap.get(key);
        const license = dep.license ?? '(unknown)';
        const status = violation ?? (dep.license ? 'ok' : 'unknown');
        lines.push(`${dep.package_name} | ${dep.ecosystem} | ${license} | ${status}`);
      }

      const denyCount = violations.filter(v => v.severity === 'deny').length;
      const warnCount = violations.filter(v => v.severity === 'warn').length;
      const unknownCount = deps.filter(d => !d.license).length;

      lines.push('');
      if (denyCount > 0) lines.push(`${denyCount} denied license${denyCount !== 1 ? 's' : ''}`);
      if (warnCount > 0) lines.push(`${warnCount} license warning${warnCount !== 1 ? 's' : ''}`);
      if (unknownCount > 0) lines.push(`${unknownCount} unknown license${unknownCount !== 1 ? 's' : ''}`);
      if (denyCount === 0 && warnCount === 0) lines.push('No policy violations');

      return truncate(lines.join('\n'));
    }

    case 'kirograph_attack_surface': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { AttackSurfaceAnalyzer } = await import('../../security/attack-surface');
      const analyzer = new AttackSurfaceAnalyzer(db);
      const result = await analyzer.analyze();

      if (result.totalRoutes === 0) {
        return 'No route nodes found in the graph. Ensure the project has been indexed with architecture analysis enabled.';
      }

      const limit = clampLimit(args.limit as number | undefined, 20);
      const routes = (args.publicOnly === true)
        ? result.criticalPaths.filter(r => r.exposureLevel === 'public')
        : result.criticalPaths;

      const lines: string[] = [
        '# Attack Surface',
        '',
        `Total routes: ${result.totalRoutes}  Public: ${result.publicRoutes}  Authenticated: ${result.authenticatedRoutes}  Routes with vulns: ${result.routesWithVulns}`,
        '',
      ];

      const displayed = routes.slice(0, limit);
      if (displayed.length === 0) {
        lines.push(args.publicOnly === true
          ? 'No public routes with vulnerable dependencies found.'
          : 'No routes with vulnerable dependencies found.');
      } else {
        for (const entry of displayed) {
          const authTag = entry.isAuthenticated ? '[auth]' : '[public]';
          const riskTag = entry.riskScore > 0 ? ` risk=${entry.riskScore.toFixed(1)}` : '';
          lines.push(`${authTag} ${entry.route} (${entry.exposureLevel})${riskTag}  ${entry.filePath}`);
          for (const dep of entry.vulnerableDeps.slice(0, 3)) {
            lines.push(`  └ ${dep.cveId} via ${dep.packageName} (${dep.hopCount} hop${dep.hopCount !== 1 ? 's' : ''}${dep.verdict ? `, ${dep.verdict}` : ''})`);
          }
          if (entry.vulnerableDeps.length > 3) {
            lines.push(`  └ …and ${entry.vulnerableDeps.length - 3} more vulns`);
          }
        }
        if (routes.length > limit) {
          lines.push('', `…and ${routes.length - limit} more routes (increase limit to see all)`);
        }
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_secrets': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { SecretsScanner } = await import('../../security/secrets');
      const scanner = new SecretsScanner(db, projectRoot);
      const result = await scanner.scan({ includeTests: args.includeTests === true });

      if (result.totalFindings === 0) {
        return `No secrets found. Scanned ${result.filesScanned} file${result.filesScanned !== 1 ? 's' : ''}.`;
      }

      let findings = result.findings;
      if (args.severity) {
        findings = findings.filter(f => f.severity === (args.severity as string));
      }

      if (findings.length === 0) {
        return `No secrets found matching severity "${args.severity}". Total findings (all severities): ${result.totalFindings}.`;
      }

      const lines: string[] = [
        `# Secrets Scan (${result.filesScanned} files scanned)`,
        '',
        `Found: ${result.totalFindings}  Critical: ${result.criticalCount}  High: ${result.highCount}`,
        '',
      ];

      for (const f of findings) {
        lines.push(`${f.severity.toUpperCase()}  ${f.type}`);
        lines.push(`  ${f.filePath}:${f.line}:${f.column}  snippet: ${f.snippet}`);
        if (f.nodeName) {
          lines.push(`  in function: ${f.nodeName}`);
        }
        if (f.entryPointCount > 0) {
          lines.push(`  reachable from ${f.entryPointCount} entry point${f.entryPointCount !== 1 ? 's' : ''}`);
        }
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_security_flows': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { DataFlowAnalyzer } = await import('../../security/data-flows');
      const analyzer = new DataFlowAnalyzer(db);
      let findings = await analyzer.analyze();

      const typeFilter = (args.type as string | undefined) ?? 'all';
      const TYPE_MAP: Record<string, string> = {
        sql: 'sql-injection',
        eval: 'dangerous-eval',
        deserialize: 'unsafe-deserialize',
        path: 'path-traversal',
        crypto: 'hardcoded-crypto',
      };

      if (typeFilter !== 'all') {
        const mapped = TYPE_MAP[typeFilter];
        if (!mapped) return `Invalid type filter "${typeFilter}". Use: sql, eval, deserialize, path, crypto, all`;
        findings = findings.filter(f => f.type === mapped);
      }

      if (findings.length === 0) {
        return typeFilter === 'all'
          ? 'No dangerous data flows detected.'
          : `No "${typeFilter}" findings detected.`;
      }

      const lines: string[] = [
        `# Security Flows (${findings.length} finding${findings.length !== 1 ? 's' : ''})`,
        '',
      ];

      for (const f of findings) {
        lines.push(`${f.severity.toUpperCase()}  [${f.owaspCategory}]  ${f.type}`);
        lines.push(`  ${f.filePath}:${f.line}  symbol: ${f.symbol}`);
        lines.push(`  ${f.description}`);
        lines.push(`  Fix: ${f.recommendation}`);
        lines.push('');
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_supply_chain': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { SupplyChainChecker } = await import('../../security/supply-chain');
      const checker = new SupplyChainChecker(db);
      const { results, errors } = await checker.checkAll();

      const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
      const thresholdArg = args.threshold as string | undefined;
      const thresholdOrder = thresholdArg ? (RISK_ORDER[thresholdArg] ?? 4) : 2; // default: medium and above

      const filtered = results
        .filter(r => (RISK_ORDER[r.riskLevel] ?? 4) <= thresholdOrder)
        .sort((a, b) => (RISK_ORDER[a.riskLevel] ?? 4) - (RISK_ORDER[b.riskLevel] ?? 4));

      if (filtered.length === 0) {
        return `No supply chain risks found at threshold "${thresholdArg ?? 'medium'}" or above. Checked ${results.length} dependencies.`;
      }

      const lines: string[] = [
        `# Supply Chain Health (${filtered.length} risks, threshold: ${thresholdArg ?? 'medium'})`,
        '',
      ];

      for (const r of filtered) {
        const scoreStr = r.scorecardScore !== null ? ` scorecard=${r.scorecardScore.toFixed(1)}/10` : '';
        const maintainerStr = r.maintainerCount !== null ? ` maintainers=${r.maintainerCount}` : '';
        lines.push(`${r.riskLevel.toUpperCase()}  ${r.packageName} (${r.ecosystem})${scoreStr}${maintainerStr}`);
        for (const reason of r.riskReasons) {
          lines.push(`  • ${reason}`);
        }
      }

      if (errors.length > 0) {
        lines.push('', `⚠ ${errors.length} package${errors.length !== 1 ? 's' : ''} could not be checked (network errors)`);
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_dep_confusion': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { DepConfusionChecker } = await import('../../security/dep-confusion');
      const checker = new DepConfusionChecker(db);
      const findings = await checker.check();

      if (findings.length === 0) {
        return 'No dependency confusion vulnerabilities detected.';
      }

      const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2 };
      const sorted = [...findings].sort((a, b) => (RISK_ORDER[a.riskLevel] ?? 3) - (RISK_ORDER[b.riskLevel] ?? 3));

      const lines: string[] = [
        `# Dependency Confusion (${findings.length} finding${findings.length !== 1 ? 's' : ''})`,
        '',
      ];

      for (const f of sorted) {
        lines.push(`${f.riskLevel.toUpperCase()}  ${f.packageName} (${f.ecosystem})`);
        lines.push(`  ${f.explanation}`);
        if (f.publicExists && f.publicVersion) {
          lines.push(`  Public version: ${f.publicVersion}${f.publicPublishedAt ? `  published: ${f.publicPublishedAt}` : ''}`);
        }
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_remediation': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

      const db = cg.getDatabase();
      db.applySecuritySchema();

      const { RemediationTracker } = await import('../../security/remediation');
      const tracker = new RemediationTracker(db);
      let statuses = tracker.getStatus();

      if (args.overdueOnly === true) {
        statuses = statuses.filter(s => s.isOverdue);
      }

      if (statuses.length === 0) {
        return args.overdueOnly === true
          ? 'No overdue vulnerabilities found.'
          : 'No open vulnerabilities with SLA tracking data found.';
      }

      // Sort: overdue first, then by slaStatus, then by severity desc
      const SLA_ORDER: Record<string, number> = { overdue: 0, warning: 1, no_fix: 2, ok: 3 };
      statuses.sort((a, b) => {
        const slaA = SLA_ORDER[a.slaStatus] ?? 3;
        const slaB = SLA_ORDER[b.slaStatus] ?? 3;
        if (slaA !== slaB) return slaA - slaB;
        return (b.severity ?? 0) - (a.severity ?? 0);
      });

      const overdueCount = statuses.filter(s => s.isOverdue).length;
      const warningCount = statuses.filter(s => s.slaStatus === 'warning').length;

      const lines: string[] = [
        `# Remediation SLA (${statuses.length} open${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}${warningCount > 0 ? `, ${warningCount} warning` : ''})`,
        '',
      ];

      for (const s of statuses) {
        const severityLabel = s.severity == null ? 'UNKNOWN'
          : s.severity >= 9 ? 'CRITICAL'
          : s.severity >= 7 ? 'HIGH'
          : s.severity >= 4 ? 'MEDIUM'
          : 'LOW';

        const slaTag = s.slaStatus === 'overdue' ? '[OVERDUE]'
          : s.slaStatus === 'warning' ? '[WARNING]'
          : s.slaStatus === 'no_fix' ? '[NO_FIX]'
          : '[OK]';

        lines.push(`${slaTag}  ${severityLabel}  ${s.cveId}  ${s.packageName}`);
        if (s.daysOpen !== null) lines.push(`  Open for ${s.daysOpen} day${s.daysOpen !== 1 ? 's' : ''}`);
        if (s.daysWithFixAvailable !== null) lines.push(`  Fix available for ${s.daysWithFixAvailable} day${s.daysWithFixAvailable !== 1 ? 's' : ''}`);
        if (s.slaDeadline !== null) {
          const deadlineDate = new Date(s.slaDeadline).toISOString().slice(0, 10);
          lines.push(`  SLA deadline: ${deadlineDate}`);
        }
      }

      return truncate(lines.join('\n'));
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
