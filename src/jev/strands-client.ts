/**
 * KiroGraph — strands-decider client
 *
 * Thin HTTP client for a local strands-decider server
 * (https://github.com/strands-labs/strands-decider), a small, fast typed-
 * classification model ("system one"). It is the local, self-hosted
 * alternative to the cloud jev backend behind the opt-in `*Mode` toggles
 * (memory relation judging, wiki contradiction detection, attack-surface auth
 * detection).
 *
 * strands-decider's `POST /v1/systemone` endpoint is wire-compatible with
 * jev's — same `{ state, model, questions }` body and the same
 * choice/score/noul answer shapes — so this client shares the DecisionClient
 * contract and the jev request/response types. The only differences from
 * JevClient: it talks to a local server (default http://127.0.0.1:8000),
 * started with `strands-decider serve`, and sends no Authorization header
 * (the server binds to localhost and has no authentication).
 */
import type { DecisionClient, JevQuestion, JevResponse } from './types';

/** strands-decider serve defaults to 127.0.0.1:8000. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
/** The published reference checkpoint; the server also accepts a local checkpoint path. */
const DEFAULT_MODEL = 'StrandsAgents/strands-decider-2B-hobson-v19';
const DEFAULT_TIMEOUT_MS = 15000;

export class StrandsError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'StrandsError';
  }
}

export interface StrandsClientOptions {
  /** Base URL of the running strands-decider server. Default: http://127.0.0.1:8000 */
  baseUrl?: string;
  /** Model/checkpoint the server was started with. Default: StrandsAgents/strands-decider-2B-hobson-v19 */
  model?: string;
  timeoutMs?: number;
}

export class StrandsClient implements DecisionClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: StrandsClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Ask one or more typed questions about a piece of state in a single
   * request. The server encodes the state once and broadcasts it across the
   * question batch, so callers should batch multiple questions about the same
   * state rather than issuing separate calls.
   */
  async ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StrandsError(`strands-decider request timed out after ${this.timeoutMs}ms`);
      }
      throw new StrandsError(
        `strands-decider request failed: ${err instanceof Error ? err.message : String(err)} `
        + `(is the server running? start it with "strands-decider serve <checkpoint> --port 8000")`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new StrandsError(`strands-decider request failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
    }

    return await res.json() as JevResponse;
  }
}

/** Minimal shape of the config fields StrandsClient needs. */
export interface StrandsConfigLike {
  strandsBaseUrl?: string;
  strandsModel?: string;
}

/**
 * Build a StrandsClient from KiroGraph config. Unlike jev, there is no API
 * key to resolve — the server is local and unauthenticated — so this never
 * throws for a missing credential; a wrong/missing server surfaces as a
 * connection error at request time instead.
 */
export function createStrandsClientFromConfig(config: StrandsConfigLike): StrandsClient {
  return new StrandsClient({ baseUrl: config.strandsBaseUrl, model: config.strandsModel });
}
