/**
 * VulnerabilityDatabaseClient
 *
 * Orchestrates vulnerability enrichment by querying configured databases,
 * merging and deduplicating results by CVE identifier, creating Vulnerability_Nodes
 * linked to affected Dependency_Nodes, and handling unreachable databases gracefully.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7
 */

import type { GraphDatabase } from '../../db/database';
import type { Edge } from '../../types';
import type { CVERecord, EnrichmentResult } from '../types';
import type { VulnDatabaseAdapter, BatchQuery } from './types';
import { logError, logWarn } from '../../errors';
import { EpssClient } from './epss-client';

const BATCH_CHUNK_SIZE = 1000;

/**
 * Compute a combined risk score (0.0–10.0) for a vulnerability.
 *
 * Formula:
 *   risk = reachability_factor × (0.4 × cvss_normalized + 0.6 × epss) × staleness_bonus
 *   scaled to 0–10: min(risk × 10, 10.0)
 *
 * @param cvss        - CVSS base score (0.0–10.0), null treated as 5.0
 * @param epss        - EPSS exploitation probability (0.0–1.0), null treated as 0.0
 * @param verdict     - Reachability verdict or null/undefined
 * @param staleness   - Dependency staleness score (0.0–1.0), null treated as 0.0
 */
export function computeRiskScore(
  cvss: number | null | undefined,
  epss: number | null | undefined,
  verdict: string | null | undefined,
  staleness: number | null | undefined,
): number {
  const cvssNormalized = (cvss ?? 5.0) / 10.0;
  const epssValue = epss ?? 0.0;

  let reachabilityFactor: number;
  if (verdict === 'affected') {
    reachabilityFactor = 1.0;
  } else if (verdict === 'under_investigation') {
    reachabilityFactor = 0.5;
  } else if (verdict === 'not_affected') {
    reachabilityFactor = 0.1;
  } else {
    // no verdict
    reachabilityFactor = 0.3;
  }

  const stalenessBonus = 1.0 + ((staleness ?? 0) * 0.2);

  const raw = reachabilityFactor * (0.4 * cvssNormalized + 0.6 * epssValue) * stalenessBonus;
  return Math.min(raw * 10, 10.0);
}

/**
 * Dependency row from sec_dependencies table.
 */
interface DependencyRow {
  node_id: string;
  ecosystem: string;
  package_name: string;
  resolved_version: string | null;
  declared_constraint: string;
}

export class VulnerabilityDatabaseClient {
  private readonly adapters: VulnDatabaseAdapter[];
  private readonly db: GraphDatabase;
  private readonly timeoutMs: number;

  constructor(
    adapters: VulnDatabaseAdapter[],
    db: GraphDatabase,
    timeoutMs: number = 30000,
  ) {
    this.adapters = adapters;
    this.db = db;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Enrich all Dependency_Nodes with vulnerability data.
   *
   * Uses batch queries (up to 1000 per HTTP request) when the adapter supports
   * `queryBatch`. Falls back to sequential single queries per dependency if batch
   * is unavailable or fails. Results are deduplicated by CVE ID across adapters.
   */
  async enrichAll(): Promise<EnrichmentResult> {
    const rawDb = this.db.getRawDb();
    const result: EnrichmentResult = {
      vulnerabilitiesFound: 0,
      dependenciesChecked: 0,
      errors: [],
      staleNodes: [],
    };

    const depRows: DependencyRow[] = rawDb.all(
      `SELECT node_id, ecosystem, package_name, resolved_version, declared_constraint
       FROM sec_dependencies`,
    );

    // Filter out deps with no usable version
    const queryableDeps = depRows.filter(d => d.resolved_version || d.declared_constraint);

    for (const adapter of this.adapters) {
      if (adapter.queryBatch) {
        await this.enrichAllBatch(adapter as typeof adapter & Required<Pick<typeof adapter, 'queryBatch'>>, queryableDeps, result);
      } else {
        await this.enrichAllSequential(adapter, queryableDeps, result);
      }
    }

    // Record lastVulnCheck for all queried deps (do once, after all adapters)
    const now = Date.now();
    for (const dep of queryableDeps) {
      rawDb.run(
        `UPDATE sec_dependencies SET last_vuln_check = ? WHERE node_id = ?`,
        [now, dep.node_id],
      );
    }
    result.dependenciesChecked = queryableDeps.length;

    // Enrich stored vulnerabilities with EPSS scores
    await this.enrichEpss(rawDb);

    // Compute combined risk scores after all enrichment is done
    await this.computeRiskScores(rawDb);

    return result;
  }

  /**
   * Fetch EPSS scores for all stored vulnerabilities and update the database.
   */
  private async enrichEpss(rawDb: any): Promise<void> {
    try {
      const cveRows: Array<{ cve_id: string }> = rawDb.all(
        `SELECT cve_id FROM sec_vulnerabilities`,
      );

      if (cveRows.length === 0) {
        return;
      }

      const cveIds = cveRows.map(r => r.cve_id);
      const epssClient = new EpssClient();
      const scores = await epssClient.fetchScores(cveIds);

      if (scores.size === 0) {
        return;
      }

      const fetchedAt = Date.now();
      for (const [cveId, { score, percentile }] of scores) {
        rawDb.run(
          `UPDATE sec_vulnerabilities SET epss_score = ?, epss_percentile = ?, epss_fetched_at = ? WHERE cve_id = ?`,
          [score, percentile, fetchedAt, cveId],
        );
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`[sec:epss] EPSS enrichment failed (non-critical): ${msg}`);
    }
  }

  /**
   * Compute and persist combined risk scores for all stored vulnerabilities.
   * Called after EPSS enrichment so epss_score values are up to date.
   */
  private async computeRiskScores(rawDb: any): Promise<void> {
    const rows: Array<{
      node_id: string;
      severity_score: number | null;
      epss_score: number | null;
      verdict: string | null;
      staleness_score: number | null;
    }> = rawDb.all(`
      SELECT v.node_id, v.severity_score, v.epss_score,
             r.verdict,
             d.staleness_score
      FROM sec_vulnerabilities v
      LEFT JOIN edges e ON e.target = v.node_id AND e.kind = 'has_vulnerability'
      LEFT JOIN sec_dependencies d ON d.node_id = e.source
      LEFT JOIN sec_reachability r ON r.vulnerability_node_id = v.node_id
    `);
    for (const row of rows) {
      const score = computeRiskScore(row.severity_score, row.epss_score, row.verdict, row.staleness_score);
      rawDb.run(`UPDATE sec_vulnerabilities SET risk_score = ? WHERE node_id = ?`, [score, row.node_id]);
    }
  }

  /**
   * Batch enrichment path: groups deps into chunks of BATCH_CHUNK_SIZE and sends
   * one HTTP request per chunk. Falls back to sequential on batch failure.
   */
  private async enrichAllBatch(
    adapter: VulnDatabaseAdapter & Required<Pick<VulnDatabaseAdapter, 'queryBatch'>>,
    deps: DependencyRow[],
    result: EnrichmentResult,
  ): Promise<void> {
    const rawDb = this.db.getRawDb();

    for (let i = 0; i < deps.length; i += BATCH_CHUNK_SIZE) {
      const chunk = deps.slice(i, i + BATCH_CHUNK_SIZE);
      const queries: BatchQuery[] = chunk.map(dep => ({
        ecosystem: dep.ecosystem,
        packageName: dep.package_name,
        version: dep.resolved_version || dep.declared_constraint,
      }));

      let batchResults: Array<CVERecord[]>;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          batchResults = await adapter.queryBatch(queries, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error: unknown) {
        // Batch failed — fall back to sequential for this chunk
        const msg = error instanceof Error ? error.message : String(error);
        logWarn(`[sec:vuln] ${adapter.name} batch query failed (${msg}), falling back to sequential for chunk of ${chunk.length}`);
        await this.enrichAllSequential(adapter, chunk, result);
        continue;
      }

      for (let j = 0; j < chunk.length; j++) {
        const dep = chunk[j]!;
        const cveRecords = batchResults[j] ?? [];
        const uniqueCves = this.deduplicateByCveId(cveRecords);
        for (const cve of uniqueCves) {
          this.upsertVulnerabilityNode(rawDb, cve, dep.node_id);
          result.vulnerabilitiesFound++;
        }
      }
    }
  }

  /**
   * Sequential enrichment path: queries one dependency at a time.
   * Used when the adapter does not support queryBatch, or as a fallback.
   */
  private async enrichAllSequential(
    adapter: VulnDatabaseAdapter,
    deps: DependencyRow[],
    result: EnrichmentResult,
  ): Promise<void> {
    const rawDb = this.db.getRawDb();

    for (const dep of deps) {
      const version = dep.resolved_version || dep.declared_constraint;
      const cveRecords = await this.queryAdaptersForDependency(dep, version, result, [adapter]);
      const uniqueCves = this.deduplicateByCveId(cveRecords);
      for (const cve of uniqueCves) {
        this.upsertVulnerabilityNode(rawDb, cve, dep.node_id);
        result.vulnerabilitiesFound++;
      }
    }
  }

  /**
   * Enrich a single Dependency_Node with vulnerability data.
   *
   * @param dependencyNodeId - The node ID of the dependency to enrich
   * @returns Array of CVE records found for this dependency
   */
  async enrichOne(dependencyNodeId: string): Promise<CVERecord[]> {
    const rawDb = this.db.getRawDb();

    const dep: DependencyRow | undefined = rawDb.get(
      `SELECT node_id, ecosystem, package_name, resolved_version, declared_constraint
       FROM sec_dependencies WHERE node_id = ?`,
      [dependencyNodeId],
    );

    if (!dep) {
      return [];
    }

    const version = dep.resolved_version || dep.declared_constraint;
    if (!version) {
      return [];
    }

    const enrichResult: EnrichmentResult = {
      vulnerabilitiesFound: 0,
      dependenciesChecked: 0,
      errors: [],
      staleNodes: [],
    };

    const cveRecords = await this.queryAdaptersForDependency(
      dep,
      version,
      enrichResult,
    );

    // Deduplicate by CVE ID
    const uniqueCves = this.deduplicateByCveId(cveRecords);

    // Create Vulnerability_Nodes and edges
    for (const cve of uniqueCves) {
      this.upsertVulnerabilityNode(rawDb, cve, dep.node_id);
    }

    // Record lastVulnCheck timestamp
    const now = Date.now();
    rawDb.run(
      `UPDATE sec_dependencies SET last_vuln_check = ? WHERE node_id = ?`,
      [now, dep.node_id],
    );

    return uniqueCves;
  }

  /**
   * Query a set of adapters for a single dependency.
   * Handles timeouts and unreachable databases gracefully.
   * Defaults to all configured adapters when adapterList is omitted.
   */
  private async queryAdaptersForDependency(
    dep: DependencyRow,
    version: string,
    result: EnrichmentResult,
    adapterList: VulnDatabaseAdapter[] = this.adapters,
  ): Promise<CVERecord[]> {
    const allRecords: CVERecord[] = [];

    for (const adapter of adapterList) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const records = await adapter.query(
            dep.ecosystem,
            dep.package_name,
            version,
            controller.signal,
          );
          allRecords.push(...records);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error: unknown) {
        // Handle unreachable database (Requirement 3.5)
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError(
          `[sec:vuln] Failed to query ${adapter.name} for ${dep.package_name}@${version}: ${errorMessage}`,
        );

        result.errors.push({
          dependency: dep.package_name,
          database: adapter.name,
          error: errorMessage,
        });

        // Set vulnDataStale flag on the dependency node
        this.markDependencyStale(dep.node_id, result);
      }
    }

    return allRecords;
  }

  /**
   * Mark a dependency node as having stale vulnerability data.
   * Retains cached data but sets the stale flag with timestamp.
   */
  private markDependencyStale(nodeId: string, result: EnrichmentResult): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();

    rawDb.run(
      `UPDATE sec_dependencies
       SET vuln_data_stale = 1, vuln_data_stale_since = ?
       WHERE node_id = ?`,
      [now, nodeId],
    );

    if (!result.staleNodes.includes(nodeId)) {
      result.staleNodes.push(nodeId);
    }

    logWarn(
      `[sec:vuln] Vulnerability data marked stale for dependency node ${nodeId}`,
    );
  }

  /**
   * Deduplicate CVE records by their ID.
   * When the same CVE is reported by multiple databases, keep the first occurrence.
   */
  private deduplicateByCveId(records: CVERecord[]): CVERecord[] {
    const seen = new Map<string, CVERecord>();
    for (const record of records) {
      if (!seen.has(record.id)) {
        seen.set(record.id, record);
      }
    }
    return [...seen.values()];
  }

  /**
   * Create or update a Vulnerability_Node and link it to the affected dependency.
   *
   * - Creates a node in `nodes` table with kind='vulnerability', ID format `vuln:<cve_id>`
   * - Inserts a row in `sec_vulnerabilities` with CVE metadata
   * - Creates a `has_vulnerability` edge from the Dependency_Node to the Vulnerability_Node
   */
  private upsertVulnerabilityNode(
    rawDb: any,
    cve: CVERecord,
    dependencyNodeId: string,
  ): void {
    const vulnNodeId = `vuln:${cve.id}`;
    const now = Date.now();

    // Truncate summary to 500 characters (Requirement 3.3)
    const summary = cve.summary.length > 500
      ? cve.summary.slice(0, 500)
      : cve.summary;

    // Determine source database from the first adapter that returned this CVE
    // (in practice, the adapter name is not stored on CVERecord, so we use
    // the first configured adapter's name as the source)
    const sourceDatabase = this.adapters.length > 0 ? this.adapters[0].name : 'unknown';

    // Upsert into nodes table
    rawDb.run(
      `INSERT OR REPLACE INTO nodes
        (id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column,
         is_exported, is_async, is_static, is_abstract, updated_at)
       VALUES (?, 'vulnerability', ?, ?, '', 'unknown', 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
      [vulnNodeId, cve.id, cve.id, now],
    );

    // Upsert into sec_vulnerabilities table
    const affectedRangesJson = JSON.stringify(cve.affectedVersionRanges);
    rawDb.run(
      `INSERT OR REPLACE INTO sec_vulnerabilities
        (node_id, cve_id, severity_score, affected_ranges, fixed_version, summary, source_database)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        vulnNodeId,
        cve.id,
        cve.severity,
        affectedRangesJson,
        cve.fixedVersion ?? null,
        summary,
        sourceDatabase,
      ],
    );

    // Create has_vulnerability edge from Dependency_Node to Vulnerability_Node
    const edge: Edge = {
      source: dependencyNodeId,
      target: vulnNodeId,
      kind: 'has_vulnerability',
      confidence: 'extracted',
      confidenceScore: 1.0,
    };
    this.db.insertEdge(edge);
  }
}
