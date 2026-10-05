/**
 * KiroGraph — decision-client factory
 *
 * Selects the typed-classification backend for the opt-in `*Mode` toggles.
 * Both backends implement the same DecisionClient contract, so each consumer
 * (memory relation judging, wiki contradiction detection, attack-surface auth
 * detection) builds its client through here and stays backend-agnostic.
 *
 *   'jev'     → JevClient      (TypeSafe System One, cloud, needs JEV_API_KEY)
 *   'strands' → StrandsClient  (strands-decider, local server, no API key)
 *
 * Any other mode value ('agent' / 'heuristic') means classification is not
 * delegated to a model at all, and this factory should not be called.
 */
import type { DecisionClient } from './types';

/** The two model-backed classification modes shared across memory/wiki/security. */
export type DecisionBackend = 'jev' | 'strands';

/** Config fields either backend might read. A superset of both *ConfigLike shapes. */
export interface DecisionConfigLike {
  jevApiKey?: string;
  jevBaseUrl?: string;
  jevModel?: string;
  strandsBaseUrl?: string;
  strandsModel?: string;
}

/**
 * Build the DecisionClient for the given backend. Throws for jev when no API
 * key is resolvable (via config or the JEV_API_KEY env var); strands never
 * throws here since it needs no credential.
 */
export async function createDecisionClient(
  backend: DecisionBackend,
  config: DecisionConfigLike,
): Promise<DecisionClient> {
  if (backend === 'strands') {
    const { createStrandsClientFromConfig } = await import('./strands-client');
    return createStrandsClientFromConfig(config);
  }
  const { createJevClientFromConfig } = await import('./client');
  return createJevClientFromConfig(config);
}
