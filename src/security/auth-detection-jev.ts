/**
 * KiroGraph-Sec — jev-based auth detection (opt-in, securityAuthDetectionMode: 'jev')
 *
 * Backstop for AttackSurfaceAnalyzer's isAuthenticated heuristic: only called
 * when the substring-match heuristic finds no auth pattern on the call path,
 * to catch custom-named auth wrappers the heuristic would otherwise silently
 * misclassify as unauthenticated. The heuristic's positive matches are
 * trusted as-is and never re-checked, keeping this cheap.
 */
import type { JevClient } from '../jev/client';

export interface JevAuthResult {
  authenticated: boolean;
  confidence: number;
}

export async function checkAuthWithJev(
  client: JevClient,
  routeName: string,
  callPathNames: string[],
): Promise<JevAuthResult> {
  const state = `Route: ${routeName}\n\nFunctions/middleware on its call path: ${callPathNames.length > 0 ? callPathNames.join(', ') : '(none found)'}`;
  const response = await client.ask(state, {
    authenticated: {
      type: 'noul',
      instructions: 'This route is protected by authentication or authorization before its handler logic runs (a session check, token verification, login guard, permission check, etc. somewhere on its call path).',
    },
  });

  const answer = response.answers.authenticated;
  if (!answer || answer.type !== 'noul') {
    throw new Error('jev did not return a noul answer for "authenticated"');
  }

  return {
    authenticated: answer.noul >= 0.5,
    confidence: answer.confidence ?? answer.noul,
  };
}
