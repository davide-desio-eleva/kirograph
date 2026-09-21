/**
 * KiroGraph-Sec Attack Surface Analyzer
 *
 * Maps all route nodes in the knowledge graph to their reachable vulnerable
 * dependencies, computing exposure levels and risk scores per route.
 */

import type { GraphDatabase } from '../db/database';

/** Auth-related name patterns for heuristic isAuthenticated detection. */
const AUTH_PATTERNS = [
  'auth',
  'authenticate',
  'middleware',
  'guard',
  'protect',
  'requirelogin',
  'isloggedin',
  'verifytoken',
  'checkauth',
  'ensureauth',
] as const;

/** Route path patterns that indicate a public-facing API. */
const PUBLIC_ROUTE_PATTERNS = ['/api/', '/v1/', '/v2/', '/v3/', '/graphql', '/rest/'];

/** Route path patterns that indicate an internal/admin route. */
const INTERNAL_ROUTE_PATTERNS = ['/internal/', '/admin/'];

export interface AttackSurfaceEntry {
  route: string;
  nodeId: string;
  filePath: string;
  isAuthenticated: boolean;
  exposureLevel: 'public' | 'authenticated' | 'internal' | 'unknown';
  vulnerableDeps: Array<{
    cveId: string;
    packageName: string;
    severity: number | null;
    epssScore: number | null;
    riskScore: number | null;
    verdict: string | null;
    hopCount: number;
  }>;
  patternMatches: Array<{
    patternId: string;
    severity: string;
    line: number;
    symbolNodeId: string;
    symbolName: string;
  }>;
  patternRiskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  riskScore: number;
}

export interface AttackSurfaceResult {
  totalRoutes: number;
  publicRoutes: number;
  authenticatedRoutes: number;
  routesWithVulns: number;
  criticalPaths: AttackSurfaceEntry[];
  allRoutes: AttackSurfaceEntry[];
}

export interface AttackSurfaceAnalyzerOptions {
  /**
   * 'heuristic' (default): substring match only.
   * 'jev': when the heuristic finds no auth pattern, ask jev to confirm/override.
   */
  authDetectionMode?: 'heuristic' | 'jev';
  /** Confidence (0.0–1.0) above which a jev auth judgment overrides the heuristic's "not authenticated" default. Default: 0.6. */
  authConfidenceThreshold?: number;
  jevApiKey?: string;
  jevBaseUrl?: string;
  jevModel?: string;
}

export class AttackSurfaceAnalyzer {
  constructor(
    private readonly db: GraphDatabase,
    private readonly opts: AttackSurfaceAnalyzerOptions = {},
  ) {}

  async analyze(): Promise<AttackSurfaceResult> {
    const rawDb = this.db.getRawDb();

    let jevClient: import('../jev/client').JevClient | undefined;
    if (this.opts.authDetectionMode === 'jev') {
      const { createJevClientFromConfig } = await import('../jev/client');
      jevClient = createJevClientFromConfig(this.opts);
    }

    // Step 1: Query all route nodes
    const routeRows: Array<{ id: string; name: string; file_path: string }> = rawDb.all(
      `SELECT id, name, file_path FROM nodes WHERE kind = 'route'`,
    );

    if (routeRows.length === 0) {
      return {
        totalRoutes: 0,
        publicRoutes: 0,
        authenticatedRoutes: 0,
        routesWithVulns: 0,
        criticalPaths: [],
        allRoutes: [],
      };
    }

    const entries: AttackSurfaceEntry[] = [];

    for (const route of routeRows) {
      // Step 2: BFS via SQL to find reachable dependency nodes (max 5 hops)
      const reachableDeps: Array<{
        node_id: string;
        package_name: string;
        hop_count: number;
      }> = rawDb.all(
        `WITH RECURSIVE reachable(node_id, depth) AS (
           SELECT target, 1 FROM edges WHERE source = ? AND kind IN ('calls', 'imports', 'references')
           UNION
           SELECT e.target, r.depth + 1
           FROM edges e
           JOIN reachable r ON e.source = r.node_id
           WHERE r.depth < 5 AND e.kind IN ('calls', 'imports', 'references')
         )
         SELECT d.node_id, d.package_name, MIN(r.depth) as hop_count
         FROM reachable r
         JOIN sec_dependencies d ON d.node_id = r.node_id
         GROUP BY d.node_id, d.package_name`,
        [route.id],
      );

      // Step 3: For each reachable dep, find affected/under_investigation vulns
      const vulnerableDeps: AttackSurfaceEntry['vulnerableDeps'] = [];

      for (const dep of reachableDeps) {
        const vulnRows: Array<{
          cve_id: string;
          package_name: string;
          severity_score: number | null;
          epss_score: number | null;
          risk_score: number | null;
          verdict: string | null;
        }> = rawDb.all(
          `SELECT v.cve_id, d.package_name, v.severity_score, v.epss_score, v.risk_score, r.verdict
           FROM sec_vulnerabilities v
           JOIN edges e ON e.target = v.node_id AND e.kind = 'has_vulnerability'
           JOIN sec_dependencies d ON d.node_id = e.source
           LEFT JOIN sec_reachability r ON r.vulnerability_node_id = v.node_id
           WHERE d.node_id = ?
             AND (r.verdict IN ('affected', 'under_investigation') OR r.verdict IS NULL)`,
          [dep.node_id],
        );

        for (const vuln of vulnRows) {
          vulnerableDeps.push({
            cveId: vuln.cve_id,
            packageName: vuln.package_name ?? dep.package_name,
            severity: vuln.severity_score,
            epssScore: vuln.epss_score,
            riskScore: vuln.risk_score,
            verdict: vuln.verdict,
            hopCount: dep.hop_count,
          });
        }
      }

      // Step 3b: Find pattern matches on the call path (table may not exist)
      const routeNodeId = route.id;
      let patternRows: Array<{
        symbol_node_id: string;
        symbol_name: string;
        pattern_id: string;
        severity: string;
        line: number;
      }> = [];
      try {
        patternRows = rawDb.all(
          `WITH RECURSIVE reachable(node_id, depth) AS (
             SELECT target, 1 FROM edges WHERE source = ? AND kind IN ('calls', 'imports', 'references')
             UNION
             SELECT e.target, r.depth + 1
             FROM edges e
             JOIN reachable r ON e.source = r.node_id
             WHERE r.depth < 5 AND e.kind IN ('calls', 'imports', 'references')
           )
           SELECT DISTINCT pm.symbol_node_id, n.name as symbol_name, pm.pattern_id, pm.severity, pm.line
           FROM reachable r
           JOIN pattern_matches pm ON pm.symbol_node_id = r.node_id
           JOIN nodes n ON n.id = pm.symbol_node_id
           WHERE pm.symbol_node_id IS NOT NULL
           ORDER BY CASE pm.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC
           LIMIT 10`,
          [routeNodeId],
        );
      } catch {
        // pattern_matches table does not exist yet — degrade silently
        patternRows = [];
      }

      const patternMatches: AttackSurfaceEntry['patternMatches'] = patternRows.map(r => ({
        patternId: r.pattern_id,
        severity: r.severity,
        line: r.line,
        symbolNodeId: r.symbol_node_id,
        symbolName: r.symbol_name,
      }));

      const patternRiskLevel: AttackSurfaceEntry['patternRiskLevel'] =
        patternMatches.length === 0
          ? 'none'
          : (patternMatches[0].severity as AttackSurfaceEntry['patternRiskLevel']);

      // Step 4: Heuristic — isAuthenticated via path node names
      const pathNodeNames: Array<{ name: string }> = rawDb.all(
        `WITH RECURSIVE reachable(node_id, depth) AS (
           SELECT target, 1 FROM edges WHERE source = ? AND kind IN ('calls', 'imports', 'references')
           UNION
           SELECT e.target, r.depth + 1
           FROM edges e
           JOIN reachable r ON e.source = r.node_id
           WHERE r.depth < 5 AND e.kind IN ('calls', 'imports', 'references')
         )
         SELECT DISTINCT n.name
         FROM reachable r
         JOIN nodes n ON n.id = r.node_id
         WHERE n.name IS NOT NULL`,
        [route.id],
      );

      let isAuthenticated = pathNodeNames.some(row => {
        const lowerName = (row.name ?? '').toLowerCase();
        return AUTH_PATTERNS.some(pattern => lowerName.includes(pattern));
      });

      // jev backstop: only consulted when the heuristic found nothing, to
      // catch custom-named auth wrappers without re-checking every route.
      if (!isAuthenticated && jevClient) {
        const { checkAuthWithJev } = await import('./auth-detection-jev');
        const jevResult = await checkAuthWithJev(
          jevClient,
          route.name ?? route.id,
          pathNodeNames.map(r => r.name).filter((n): n is string => !!n),
        );
        const threshold = this.opts.authConfidenceThreshold ?? 0.6;
        if (jevResult.authenticated && jevResult.confidence >= threshold) {
          isAuthenticated = true;
        }
      }

      // Step 5: Determine exposure level
      const routeName = (route.name ?? '').toLowerCase();
      let exposureLevel: AttackSurfaceEntry['exposureLevel'];

      if (INTERNAL_ROUTE_PATTERNS.some(p => routeName.includes(p))) {
        exposureLevel = 'internal';
      } else if (isAuthenticated) {
        exposureLevel = 'authenticated';
      } else if (PUBLIC_ROUTE_PATTERNS.some(p => routeName.includes(p))) {
        exposureLevel = 'public';
      } else {
        exposureLevel = 'unknown';
      }

      // Step 6: riskScore = max risk_score of reachable affected vulns, plus pattern bonus
      const affectedVulns = vulnerableDeps.filter(v => v.verdict === 'affected' || v.verdict === 'under_investigation');
      const baseRiskScore = affectedVulns.reduce((max, v) => {
        if (v.riskScore != null && v.riskScore > max) return v.riskScore;
        return max;
      }, 0);

      const patternBonus: Record<AttackSurfaceEntry['patternRiskLevel'], number> = {
        none: 0, low: 0.3, medium: 0.6, high: 0.8, critical: 1.0,
      };
      const riskScore = Math.min(10, baseRiskScore + (patternBonus[patternRiskLevel] ?? 0));

      entries.push({
        route: route.name ?? route.id,
        nodeId: route.id,
        filePath: route.file_path ?? '',
        isAuthenticated,
        exposureLevel,
        vulnerableDeps,
        patternMatches,
        patternRiskLevel,
        riskScore,
      });
    }

    // Compute summary stats
    const publicRoutes = entries.filter(e => e.exposureLevel === 'public').length;
    const authenticatedRoutes = entries.filter(
      e => e.exposureLevel === 'authenticated' || e.exposureLevel === 'internal',
    ).length;
    const routesWithVulns = entries.filter(e => e.vulnerableDeps.length > 0).length;

    // Critical paths: routes with affected/under_investigation vulns, sorted by riskScore desc
    const criticalPaths = entries
      .filter(e => e.vulnerableDeps.length > 0)
      .sort((a, b) => b.riskScore - a.riskScore);

    const allRoutes = entries.sort((a, b) => b.riskScore - a.riskScore);

    return {
      totalRoutes: entries.length,
      publicRoutes,
      authenticatedRoutes,
      routesWithVulns,
      criticalPaths,
      allRoutes,
    };
  }
}
