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
const DEFAULT_TIMEOUT_MS = 30_000;
const OSV_BATCH_MAX_QUERIES = 1000;
const MAX_SUMMARY_LENGTH = 500;

// ── OsvAdapter Implementation ─────────────────────────────────────────────────

export class OsvAdapter implements VulnDatabaseAdapter {
  public readonly name = 'OSV';

  private readonly apiUrl: string;
  private readonly batchApiUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: { apiUrl?: string; batchApiUrl?: string; timeoutMs?: number }) {
    this.apiUrl = options?.apiUrl ?? OSV_API_URL;
    this.batchApiUrl = options?.batchApiUrl ?? OSV_BATCH_API_URL;
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

    // Rebuild full results array aligned with input queries
    return queries.map((_, i) => {
      const osvIdx = indexMap[i];
      if (osvIdx === null) return [];
      const resultEntry = batchResults[osvIdx];
      if (!resultEntry) return [];
      return this.parseResponse({ vulns: resultEntry.vulns });
    });
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
   * Extract CVSS v3.1 base score from the severity array.
   * Returns 0 if no CVSS score is available.
   */
  private extractSeverity(vuln: OsvVulnerability): number {
    if (!vuln.severity || vuln.severity.length === 0) {
      return 0;
    }

    for (const sev of vuln.severity) {
      if (sev.type === 'CVSS_V3') {
        const score = this.parseCvssScore(sev.score);
        if (score !== null) {
          return score;
        }
      }
    }

    // Try any severity type as fallback
    for (const sev of vuln.severity) {
      const score = this.parseCvssScore(sev.score);
      if (score !== null) {
        return score;
      }
    }

    return 0;
  }

  /**
   * Parse a CVSS vector string or numeric score.
   * CVSS vectors look like: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
   * The base score is not directly in the vector — we extract it if it's a plain number,
   * or return null if we can't parse it.
   */
  private parseCvssScore(scoreStr: string): number | null {
    // If it's a plain number
    const num = parseFloat(scoreStr);
    if (!isNaN(num) && num >= 0 && num <= 10) {
      return num;
    }

    // CVSS vector strings don't contain the base score directly.
    // OSV sometimes provides the score as a plain number in the score field.
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
