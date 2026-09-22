/**
 * OSV API Adapter
 *
 * Queries the OSV (Open Source Vulnerabilities) database for known CVEs
 * affecting project dependencies. Implements the VulnDatabaseAdapter interface.
 */

import { CVERecord, VersionRange } from '../types';
import type { VulnDatabaseAdapter, BatchQuery } from './types';
import { VulnDatabaseError } from '../errors';
import { logWarn, logError } from '../../errors';

export type { VulnDatabaseAdapter, BatchQuery };

// ── Ecosystem Mapping ─────────────────────────────────────────────────────────

const ECOSYSTEM_MAP: Record<string, string> = {
  npm: 'npm',
  maven: 'Maven',
  go: 'Go',
  pypi: 'PyPI',
  python: 'PyPI',    // manifest parser sends 'python' for requirements.txt
  cargo: 'crates.io',
  pyproject: 'PyPI',  // pyproject.toml (Poetry/Hatch/PDM/PEP 621)
  nuget: 'NuGet',
  csproj: 'NuGet',   // manifest parser sends 'csproj' for .csproj files
  gradle: 'Maven',    // Gradle projects use Maven Central
  rubygems: 'RubyGems',
  composer: 'Packagist',
  swift: 'SwiftURL',
  pub: 'Pub',
  hex: 'Hex',
};

// ── OSV Request/Response Types ───────────────────────────────────────────────

interface OsvSeverity {
  type: string;
  score: string;
}

interface OsvAffectedRange {
  type: string;
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvAffectedRange[];
  versions?: string[];
}

interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  /** OSV per-database extras. GHSA records expose a coarse qualitative severity here. */
  database_specific?: { severity?: string;[key: string]: unknown };
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
}

interface OsvBatchQueryItem {
  package: { name: string; ecosystem: string };
  version: string;
}

interface OsvBatchResponse {
  results: Array<{ vulns?: OsvVulnerability[] }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OSV_API_URL = 'https://api.osv.dev/v1/query';
const OSV_BATCH_API_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_DETAIL_URL = 'https://api.osv.dev/v1/vulns';
const DEFAULT_TIMEOUT_MS = 30_000;
const OSV_BATCH_MAX_QUERIES = 1000;
const OSV_DETAIL_FETCH_CONCURRENCY = 10;
const MAX_SUMMARY_LENGTH = 500;

// ── CVSS parsing ──────────────────────────────────────────────────────────────

/**
 * Parse an OSV severity `score` field into a CVSS base score (0.0–10.0).
 *
 * The field is either a plain number (rare) or a CVSS vector string such as
 * "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H". For v3.0/3.1 vectors we compute
 * the base score from the metrics per the FIRST CVSS specification. Returns null
 * when the value can't be interpreted.
 */
export function parseCvssScore(scoreStr: string | undefined): number | null {
  if (!scoreStr) return null;

  const trimmed = scoreStr.trim();

  // Plain numeric score.
  const num = parseFloat(trimmed);
  if (!isNaN(num) && String(num) === trimmed && num >= 0 && num <= 10) {
    return num;
  }

  // CVSS vector string.
  if (/^CVSS:3\.[01]\//i.test(trimmed)) {
    return computeCvssV3BaseScore(trimmed);
  }

  return null;
}

/** Round up to one decimal place, per the CVSS spec's roundup() function. */
function cvssRoundUp(value: number): number {
  const intInput = Math.round(value * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

/**
 * Compute the CVSS v3.0/3.1 base score from a vector string.
 * Implements the base-score equations from the FIRST CVSS v3.1 specification.
 * Returns null if required base metrics are missing.
 */
export function computeCvssV3BaseScore(vector: string): number | null {
  const metrics: Record<string, string> = {};
  for (const part of vector.split('/')) {
    const [k, v] = part.split(':');
    if (k && v) metrics[k.toUpperCase()] = v.toUpperCase();
  }

  // Required base metrics.
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV];
  const AC = { L: 0.77, H: 0.44 }[metrics.AC];
  const UI = { N: 0.85, R: 0.62 }[metrics.UI];
  const scopeChanged = metrics.S === 'C';
  // Privileges Required depends on Scope.
  const PR = ((): number | undefined => {
    if (metrics.PR === 'N') return 0.85;
    if (metrics.PR === 'L') return scopeChanged ? 0.68 : 0.62;
    if (metrics.PR === 'H') return scopeChanged ? 0.5 : 0.27;
    return undefined;
  })();
  const impactVal = { H: 0.56, L: 0.22, N: 0.0 };
  const C = impactVal[metrics.C as keyof typeof impactVal];
  const I = impactVal[metrics.I as keyof typeof impactVal];
  const A = impactVal[metrics.A as keyof typeof impactVal];

  if ([AV, AC, UI, PR, C, I, A].some(v => v === undefined)) {
    return null;
  }

  const iscBase = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = scopeChanged
    ? 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15)
    : 6.42 * iscBase;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;

  if (impact <= 0) return 0.0;

  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);

  return cvssRoundUp(raw);
}

/**
 * Map a coarse qualitative severity label (GHSA `database_specific.severity`,
 * or a CVSS qualitative rating) to a representative numeric score. Used only as
 * a fallback when no CVSS vector is available. Returns null for unknown labels.
 */
export function qualitativeToScore(label: string | undefined): number | null {
  if (!label) return null;
  switch (label.trim().toUpperCase()) {
    case 'CRITICAL': return 9.8;
    case 'HIGH': return 7.5;
    case 'MODERATE':
    case 'MEDIUM': return 5.5;
    case 'LOW': return 3.1;
    default: return null;
  }
}

// ── OsvAdapter Implementation ─────────────────────────────────────────────────

export class OsvAdapter implements VulnDatabaseAdapter {
  public readonly name = 'OSV';

  private readonly apiUrl: string;
  private readonly batchApiUrl: string;
  private readonly vulnDetailUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: { apiUrl?: string; batchApiUrl?: string; vulnDetailUrl?: string; timeoutMs?: number }) {
    this.apiUrl = options?.apiUrl ?? OSV_API_URL;
    this.batchApiUrl = options?.batchApiUrl ?? OSV_BATCH_API_URL;
    this.vulnDetailUrl = options?.vulnDetailUrl ?? OSV_VULN_DETAIL_URL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Batch query up to OSV_BATCH_MAX_QUERIES packages in a single HTTP request.
   * Results are returned in the same order as the input queries.
   * Queries for unsupported ecosystems produce empty results without an HTTP call.
   */
  async queryBatch(
    queries: BatchQuery[],
    signal?: AbortSignal,
  ): Promise<Array<CVERecord[]>> {
    if (queries.length === 0) return [];

    // Map each query to its OSV ecosystem — track indices of unsupported ones
    const osvQueries: OsvBatchQueryItem[] = [];
    const indexMap: Array<number | null> = []; // index into osvQueries, or null if unsupported

    for (const q of queries) {
      const osvEcosystem = ECOSYSTEM_MAP[q.ecosystem.toLowerCase()];
      if (!osvEcosystem) {
        logWarn(`OSV adapter: unsupported ecosystem "${q.ecosystem}", skipping batch entry`);
        indexMap.push(null);
      } else {
        indexMap.push(osvQueries.length);
        osvQueries.push({
          package: { name: q.packageName, ecosystem: osvEcosystem },
          version: q.version,
        });
      }
    }

    if (osvQueries.length === 0) {
      return queries.map(() => []);
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const combinedSignal = signal
      ? combineAbortSignals(signal, timeoutController.signal)
      : timeoutController.signal;

    let batchResults: Array<{ vulns?: OsvVulnerability[] }>;

    try {
      const response = await fetch(this.batchApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: osvQueries }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new VulnDatabaseError(
          `OSV batch API returned HTTP ${response.status}: ${response.statusText}`,
          'OSV',
          response.status,
        );
      }

      const data = (await response.json()) as OsvBatchResponse;
      batchResults = data.results ?? [];
    } catch (error: unknown) {
      if (error instanceof VulnDatabaseError) throw error;
      if (isAbortError(error)) {
        const msg = timeoutController.signal.aborted
          ? `OSV batch query timed out after ${this.timeoutMs}ms (${osvQueries.length} packages)`
          : `OSV batch query aborted`;
        logError(msg);
        throw new VulnDatabaseError(msg, 'OSV');
      }
      const msg = error instanceof Error ? error.message : String(error);
      logError(`OSV batch query failed: ${msg}`);
      throw new VulnDatabaseError(`Network error in OSV batch query: ${msg}`, 'OSV');
    } finally {
      clearTimeout(timeoutId);
    }

    // OSV's batch endpoint only ever returns { id, modified } stubs — no
    // severity, affected ranges, summary, or fixed version. Fetch full
    // details for every unique vulnerability ID found, deduplicated since
    // many packages in the same batch often share the same advisory.
    const uniqueIds = new Set<string>();
    for (const result of batchResults) {
      for (const vuln of result.vulns ?? []) {
        uniqueIds.add(vuln.id);
      }
    }
    const detailsById = await this.fetchVulnDetails([...uniqueIds], combinedSignal);

    // Rebuild full results array aligned with input queries
    return queries.map((_, i) => {
      const osvIdx = indexMap[i];
      if (osvIdx === null) return [];
      const resultEntry = batchResults[osvIdx];
      if (!resultEntry) return [];
      const fullVulns = (resultEntry.vulns ?? []).map(stub => detailsById.get(stub.id) ?? stub);
      return this.parseResponse({ vulns: fullVulns });
    });
  }

  /**
   * Fetch full vulnerability records for a set of IDs via OSV's per-ID detail
   * endpoint (the batch endpoint doesn't include this data). Runs with
   * bounded concurrency; a failure on one ID is logged and that ID falls
   * back to its stub (still usable, just without severity/EPSS-relevant data)
   * rather than failing the whole batch.
   */
  private async fetchVulnDetails(
    ids: string[],
    signal: AbortSignal,
  ): Promise<Map<string, OsvVulnerability>> {
    const results = new Map<string, OsvVulnerability>();
    if (ids.length === 0) return results;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const response = await fetch(`${this.vulnDetailUrl}/${encodeURIComponent(id)}`, { signal });
          if (!response.ok) {
            logWarn(`OSV: failed to fetch details for ${id}: HTTP ${response.status}`);
            continue;
          }
          const vuln = (await response.json()) as OsvVulnerability;
          results.set(id, vuln);
        } catch (error: unknown) {
          if (isAbortError(error)) return;
          const msg = error instanceof Error ? error.message : String(error);
          logWarn(`OSV: failed to fetch details for ${id}: ${msg}`);
        }
      }
    };

    const workerCount = Math.min(OSV_DETAIL_FETCH_CONCURRENCY, ids.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  async query(
    ecosystem: string,
    packageName: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<CVERecord[]> {
    const osvEcosystem = ECOSYSTEM_MAP[ecosystem.toLowerCase()];
    if (!osvEcosystem) {
      logWarn(`OSV adapter: unsupported ecosystem "${ecosystem}", skipping query`);
      return [];
    }

    const body = JSON.stringify({
      package: {
        name: packageName,
        ecosystem: osvEcosystem,
      },
      version,
    });

    // Create a timeout abort signal and combine with any external signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);

    const combinedSignal = signal
      ? combineAbortSignals(signal, timeoutController.signal)
      : timeoutController.signal;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new VulnDatabaseError(
          `OSV API returned HTTP ${response.status}: ${response.statusText}`,
          'OSV',
          response.status,
        );
      }

      const data = (await response.json()) as OsvQueryResponse;
      return this.parseResponse(data);
    } catch (error: unknown) {
      if (error instanceof VulnDatabaseError) {
        throw error;
      }

      if (isAbortError(error)) {
        const isTimeout = timeoutController.signal.aborted;
        const message = isTimeout
          ? `OSV query timed out after ${this.timeoutMs}ms for ${packageName}@${version}`
          : `OSV query aborted for ${packageName}@${version}`;
        logError(message);
        throw new VulnDatabaseError(message, 'OSV');
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      logError(`OSV query failed for ${packageName}@${version}: ${errorMessage}`);
      throw new VulnDatabaseError(
        `Network error querying OSV for ${packageName}@${version}: ${errorMessage}`,
        'OSV',
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse the OSV API response into CVERecord objects.
   */
  private parseResponse(data: OsvQueryResponse): CVERecord[] {
    if (!data.vulns || data.vulns.length === 0) {
      return [];
    }

    const records: CVERecord[] = [];

    for (const vuln of data.vulns) {
      const cveId = this.extractCveId(vuln);
      if (!cveId) {
        // Skip vulnerabilities without a CVE identifier
        continue;
      }

      const severity = this.extractSeverity(vuln);
      const { ranges, fixedVersion } = this.extractAffectedRanges(vuln);
      const summary = this.extractSummary(vuln);

      records.push({
        id: cveId,
        severity,
        affectedVersionRanges: ranges,
        fixedVersion,
        summary,
      });
    }

    return records;
  }

  /**
   * Extract CVE ID from the vulnerability's aliases or use the OSV ID.
   * Prefers CVE-* identifiers from the aliases array.
   */
  private extractCveId(vuln: OsvVulnerability): string | undefined {
    // Look for a CVE alias first
    if (vuln.aliases) {
      const cveAlias = vuln.aliases.find((alias) => alias.startsWith('CVE-'));
      if (cveAlias) {
        return cveAlias;
      }
    }

    // Fall back to the OSV ID (e.g., GHSA-xxxx-xxxx-xxxx)
    return vuln.id;
  }

  /**
   * Extract a CVSS base score (0.0–10.0) for the vulnerability.
   *
   * OSV encodes severity as an array of `{ type, score }`. For CVSS_V3/CVSS_V4
   * the `score` field is a *vector string* (e.g. "CVSS:3.1/AV:N/AC:L/...") — NOT
   * a plain number — so the base score must be computed from the vector.
   *
   * Resolution order:
   *   1. CVSS_V3 vector → computed base score
   *   2. CVSS_V4 vector → computed base score
   *   3. Any severity entry that happens to be a plain number
   *   4. Coarse qualitative `database_specific.severity` (GHSA) → representative score
   *
   * Returns null when no severity data is available (so callers can distinguish
   * "unknown" from a genuine 0.0 score).
   */
  private extractSeverity(vuln: OsvVulnerability): number | null {
    if (vuln.severity && vuln.severity.length > 0) {
      // Prefer CVSS v3, then v4, then any parseable entry.
      const byType = (type: string) =>
        vuln.severity!.filter(s => s.type === type);

      for (const sev of [...byType('CVSS_V3'), ...byType('CVSS_V4')]) {
        const score = parseCvssScore(sev.score);
        if (score !== null) return score;
      }
      for (const sev of vuln.severity) {
        const score = parseCvssScore(sev.score);
        if (score !== null) return score;
      }
    }

    // Fallback: GHSA advisories expose a coarse qualitative severity here even
    // when a CVSS vector is absent.
    const qualitative = qualitativeToScore(vuln.database_specific?.severity);
    if (qualitative !== null) return qualitative;

    return null;
  }

  /**
   * Extract affected version ranges and the first fixed version from the vulnerability.
   */
  private extractAffectedRanges(vuln: OsvVulnerability): {
    ranges: VersionRange[];
    fixedVersion?: string;
  } {
    const ranges: VersionRange[] = [];
    let fixedVersion: string | undefined;

    if (!vuln.affected) {
      return { ranges, fixedVersion };
    }

    for (const affected of vuln.affected) {
      if (!affected.ranges) {
        continue;
      }

      for (const range of affected.ranges) {
        if (!range.events || range.events.length === 0) {
          continue;
        }

        const versionRange: VersionRange = {};

        for (const event of range.events) {
          if (event.introduced) {
            versionRange.introduced = event.introduced;
          }
          if (event.fixed) {
            versionRange.fixed = event.fixed;
            // Capture the first fixed version we encounter
            if (!fixedVersion) {
              fixedVersion = event.fixed;
            }
          }
          if (event.last_affected) {
            versionRange.lastAffected = event.last_affected;
          }
        }

        // Only add ranges that have at least one meaningful field
        if (versionRange.introduced || versionRange.fixed || versionRange.lastAffected) {
          ranges.push(versionRange);
        }
      }
    }

    return { ranges, fixedVersion };
  }

  /**
   * Extract and truncate the summary from the vulnerability.
   * Prefers the summary field, falls back to details.
   */
  private extractSummary(vuln: OsvVulnerability): string {
    const text = vuln.summary || vuln.details || '';
    if (text.length <= MAX_SUMMARY_LENGTH) {
      return text;
    }
    return text.slice(0, MAX_SUMMARY_LENGTH - 3) + '...';
  }
}

// ── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Combine multiple AbortSignals into one that aborts when any of them aborts.
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }

    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  return controller.signal;
}

/**
 * Check if an error is an abort/timeout error.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  return false;
}
