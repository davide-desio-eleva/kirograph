/**
 * SecurityPipeline — Orchestrates the security analysis phases.
 *
 * Phases (in order):
 *   1. Manifest parsing — discover and parse dependency manifests
 *   2. Dependency integration — link dependencies to code symbols
 *   3. Vulnerability enrichment — query databases for CVEs (if securityAutoEnrich)
 *   4. Reachability analysis — determine if vulnerable code is reachable
 *
 * Reports progress via callback and returns a SecurityResult with counts and duration.
 *
 * Requirements: 9.3, 9.5
 */

import type { GraphDatabase } from '../db/database';
import type { KiroGraphConfig } from '../config';
import type { SecurityResult } from './types';
import { ManifestParser } from './manifest/parser';
import { DependencyGraphIntegrator } from './integrator';
import { VulnerabilityDatabaseClient } from './vuln/client';
import { OsvAdapter } from './vuln/osv-adapter';
import { ReachabilityAnalyzer } from './reachability';
import { logWarn } from '../errors';

/**
 * SecurityPipeline orchestrates the full security analysis workflow.
 */
export class SecurityPipeline {
  private readonly db: GraphDatabase;
  private readonly config: KiroGraphConfig;
  private readonly projectRoot: string;

  constructor(db: GraphDatabase, config: KiroGraphConfig, projectRoot: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /**
   * Run the full security analysis pipeline.
   *
   * @param onProgress - Optional callback reporting (phase, current, total)
   * @returns SecurityResult with counts and duration
   */
  async run(
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<SecurityResult> {
    const start = Date.now();

    const result: SecurityResult = {
      manifestsDiscovered: 0,
      dependenciesCreated: 0,
      vulnerabilitiesFound: 0,
      affectedCount: 0,
      notAffectedCount: 0,
      underInvestigationCount: 0,
      duration: 0,
    };

    // ── Phase 1: Manifest Parsing ─────────────────────────────────────────────
    onProgress?.('manifest-parsing', 0, 4);

    const parser = new ManifestParser(this.db, this.projectRoot, {
      include: this.config.include,
      exclude: this.config.exclude,
    });
    const parseResult = await parser.parseAll();

    result.manifestsDiscovered = parseResult.manifestsParsed;
    result.dependenciesCreated = parseResult.dependenciesCreated;

    onProgress?.('manifest-parsing', 1, 4);

    // ── Phase 2: Dependency Integration ───────────────────────────────────────
    onProgress?.('dependency-integration', 1, 4);

    const integrator = new DependencyGraphIntegrator(this.db, this.projectRoot);
    await integrator.integrate();
    await integrator.resolveTransitives(10);
    await integrator.cleanup();

    onProgress?.('dependency-integration', 2, 4);

    // ── Phase 3: Vulnerability Enrichment (conditional) ───────────────────────
    if (this.config.securityAutoEnrich) {
      onProgress?.('vulnerability-enrichment', 2, 4);

      const adapters = this.createVulnAdapters();
      const vulnClient = new VulnerabilityDatabaseClient(adapters, this.db);
      const enrichResult = await vulnClient.enrichAll();

      result.vulnerabilitiesFound = enrichResult.vulnerabilitiesFound;

      onProgress?.('vulnerability-enrichment', 3, 4);
    } else {
      onProgress?.('vulnerability-enrichment', 3, 4);
    }

    // ── Phase 4: Reachability Analysis ────────────────────────────────────────
    onProgress?.('reachability-analysis', 3, 4);

    const reachability = new ReachabilityAnalyzer(this.db, this.config);
    const reachResults = await reachability.analyzeAll();

    // Count verdicts
    for (const [, reachResult] of reachResults) {
      switch (reachResult.verdict) {
        case 'affected':
          result.affectedCount++;
          break;
        case 'not_affected':
          result.notAffectedCount++;
          break;
        case 'under_investigation':
          result.underInvestigationCount++;
          break;
      }
    }

    // Generate impact summaries for affected vulnerabilities
    for (const [vulnNodeId, reachResult] of reachResults) {
      if (reachResult.verdict === 'affected') {
        await reachability.getImpactSummary(vulnNodeId);
      }
    }

    onProgress?.('reachability-analysis', 4, 4);

    result.duration = Date.now() - start;
    return result;
  }

  /**
   * Create vulnerability database adapters based on config.
   */
  private createVulnAdapters(): import('./vuln/types').VulnDatabaseAdapter[] {
    const adapters: import('./vuln/types').VulnDatabaseAdapter[] = [];

    for (const dbName of this.config.securityDatabases) {
      switch (dbName.toUpperCase()) {
        case 'OSV':
          adapters.push(new OsvAdapter());
          break;
        default:
          logWarn(`[sec:pipeline] Unknown vulnerability database "${dbName}", skipping`);
          break;
      }
    }

    // Fallback to OSV if no valid adapters configured
    if (adapters.length === 0) {
      adapters.push(new OsvAdapter());
    }

    return adapters;
  }
}
