/**
 * KiroGraph — jev (TypeSafe System One) client
 *
 * Thin HTTP client for https://docs.typesafe.ai's fast typed-classification
 * model. Used by opt-in "jev mode" toggles across the codebase (memory
 * relation judging, wiki contradiction detection, attack-surface auth
 * detection) as a cheaper/faster alternative to delegating a narrow
 * classification decision to a full agent turn.
 */
import type { JevQuestion, JevResponse } from './types';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 15000;

export class JevError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'JevError';
  }
}

export interface JevClientOptions {
  apiKey: string;
  /** Override for testing / self-hosted deployments. Default: https://api.typesafe.ai */
  baseUrl?: string;
  /** Default: jev-latest */
  model?: string;
  timeoutMs?: number;
}

export class JevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: JevClientOptions) {
    if (!opts.apiKey) {
      throw new JevError('jev API key is required');
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Ask one or more typed questions about a piece of state in a single
   * request — the API evaluates them in parallel, so callers should batch
   * multiple questions about the same state rather than issuing separate calls.
   */
  async ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new JevError(`jev request timed out after ${this.timeoutMs}ms`);
      }
      throw new JevError(`jev request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new JevError(`jev request failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
    }

    return await res.json() as JevResponse;
  }
}

/** Minimal shape of the config fields JevClient needs — avoids importing the full KiroGraphConfig type. */
export interface JevConfigLike {
  jevApiKey?: string;
  jevBaseUrl?: string;
  jevModel?: string;
}

/**
 * Build a JevClient from KiroGraph config, falling back to the JEV_API_KEY
 * env var when `jevApiKey` isn't set in .kirograph/config.json (config.json
 * is often committed to source control — a config field is provided mainly
 * for pointing at a local mock server in tests).
 */
export function createJevClientFromConfig(config: JevConfigLike): JevClient {
  const apiKey = config.jevApiKey || process.env.JEV_API_KEY;
  if (!apiKey) {
    throw new JevError(
      'jev API key not set — set the JEV_API_KEY environment variable, or "jevApiKey" in .kirograph/config.json',
    );
  }
  return new JevClient({ apiKey, baseUrl: config.jevBaseUrl, model: config.jevModel });
}
