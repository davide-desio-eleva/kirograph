/**
 * KiroGraph Memory — jev-based relation classification (opt-in, memoryRelationMode: 'jev')
 *
 * Classifies the relation between two observations via a single jev Choice
 * question instead of requiring the calling agent to reason it out manually
 * and supply `relation`/`confidence` itself.
 */
import type { JevClient } from '../jev/client';
import type { RelationType } from './types';

const RELATION_CRITERIA: Record<RelationType, string> = {
  supersedes: 'Observation B replaces or invalidates Observation A as the current decision or fact — A is now outdated.',
  conflicts_with: 'A and B make contradictory claims about the same thing that cannot both be true at the same time.',
  compatible: 'A and B are both true and can coexist without contradiction, even if they discuss related things.',
  scoped: 'A and B both apply, but in different, non-overlapping contexts or scopes (e.g. different environments, services, or time periods).',
  related: 'A and B are on the same topic and worth cross-referencing, but neither conflicts with nor supersedes the other.',
  not_conflict: 'A and B only appear related on the surface (shared keywords) but are not meaningfully connected.',
};

export interface JevRelationClassification {
  relation: RelationType;
  confidence: number;
}

/** Classify how observation B relates to observation A. */
export async function classifyRelationWithJev(
  client: JevClient,
  contentA: string,
  contentB: string,
): Promise<JevRelationClassification> {
  const state = `Observation A: ${contentA}\n\nObservation B: ${contentB}`;
  const response = await client.ask(state, {
    relation: {
      type: 'choice',
      instructions: 'How does Observation B relate to Observation A?',
      criteria: RELATION_CRITERIA,
    },
  });

  const answer = response.answers.relation;
  if (!answer || answer.type !== 'choice') {
    throw new Error('jev did not return a choice answer for "relation"');
  }
  if (!(answer.choice in RELATION_CRITERIA)) {
    throw new Error(`jev returned an unrecognized relation "${answer.choice}"`);
  }

  return {
    relation: answer.choice as RelationType,
    confidence: answer.confidence ?? 0,
  };
}
