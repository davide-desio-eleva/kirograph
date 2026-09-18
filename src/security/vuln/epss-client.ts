/**
 * EPSS (Exploit Prediction Scoring System) Client
 *
 * Fetches exploit prediction scores from the FIRST.org EPSS API for CVE IDs.
 * EPSS is non-critical: on error, an empty map is returned so the caller can
 * continue without scores.
 *
 * API: https://api.first.org/data/v1/epss
 */

import { logWarn, logError } from '../../errors';

const EPSS_API_URL = 'https://api.first.org/data/v1/epss';
const CHUNK_SIZE = 100; // Keep URL under 2048-char limit (100 CVEs × ~16 chars each)
const TIMEOUT_MS = 30000;

interface EpssApiResponse {
  status: string;
  status_code: number;
  data: Array<{
    cve: string;
    epss: string;
    percentile: string;
    date: string;
  }>;
}

export class EpssClient {
  /**
   * Fetch EPSS scores for a list of CVE IDs.
   *
   * CVEs are batched into chunks of 500 per request. Missing CVEs simply do
   * not appear in the response and are omitted from the returned map.
   *
   * @param cveIds - List of CVE identifiers (e.g. ["CVE-2021-44228", ...])
   * @returns Map from CVE ID to { score, percentile } (floats in [0, 1])
   */
  async fetchScores(cveIds: string[]): Promise<Map<string, { score: number; percentile: number }>> {
    const result = new Map<string, { score: number; percentile: number }>();

    if (cveIds.length === 0) {
      return result;
    }

    for (let i = 0; i < cveIds.length; i += CHUNK_SIZE) {
      const chunk = cveIds.slice(i, i + CHUNK_SIZE);
      try {
        const chunkResult = await this.fetchChunk(chunk);
        for (const [cve, scores] of chunkResult) {
          result.set(cve, scores);
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logWarn(`[sec:epss] Failed to fetch EPSS scores for chunk of ${chunk.length} CVEs: ${msg}`);
        // EPSS is non-critical — continue with partial results
      }
    }

    return result;
  }

  private async fetchChunk(
    cveIds: string[],
  ): Promise<Map<string, { score: number; percentile: number }>> {
    const result = new Map<string, { score: number; percentile: number }>();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const cveParam = cveIds.join(',');
      const url = `${EPSS_API_URL}?cve=${encodeURIComponent(cveParam)}`;

      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        logWarn(`[sec:epss] EPSS API returned HTTP ${response.status}`);
        return result;
      }

      const json = (await response.json()) as EpssApiResponse;

      if (json.status !== 'OK' || !Array.isArray(json.data)) {
        logWarn(`[sec:epss] Unexpected EPSS API response structure`);
        return result;
      }

      for (const entry of json.data) {
        const score = parseFloat(entry.epss);
        const percentile = parseFloat(entry.percentile);
        if (!isNaN(score) && !isNaN(percentile)) {
          result.set(entry.cve, { score, percentile });
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`[sec:epss] Error fetching EPSS chunk: ${msg}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    return result;
  }
}
