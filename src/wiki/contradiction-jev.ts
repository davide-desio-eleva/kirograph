/**
 * KiroGraph Wiki — jev-based contradiction detection (opt-in, wikiContradictionMode: 'jev')
 *
 * Replaces the keyword-heuristic contradiction check (co-occurring negation
 * words like "instead of"/"superseded" on FTS-similar pages) with an actual
 * judgment call, still restricted to the same FTS-similar candidate pairs.
 */
import type { JevClient } from '../jev/client';

export interface JevContradictionResult {
  contradicts: boolean;
  confidence: number;
}

export async function checkContradictionWithJev(
  client: JevClient,
  contentA: string,
  contentB: string,
): Promise<JevContradictionResult> {
  const state = `Page A:\n${contentA}\n\nPage B:\n${contentB}`;
  const response = await client.ask(state, {
    contradicts: {
      type: 'noul',
      instructions: 'Page A and Page B make claims that directly contradict each other about the same subject — not just related, actually incompatible.',
    },
  });

  const answer = response.answers.contradicts;
  if (!answer || answer.type !== 'noul') {
    throw new Error('jev did not return a noul answer for "contradicts"');
  }

  return {
    contradicts: answer.noul >= 0.5,
    confidence: answer.confidence ?? answer.noul,
  };
}
