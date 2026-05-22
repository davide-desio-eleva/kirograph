/**
 * Gemini CLI target — alias for Antigravity.
 * Both use GEMINI.md + .gemini/settings/mcp.json.
 * The only difference is the label and next-steps message.
 */

import { installAntigravityEarly, installAntigravityLate, uninitAntigravity } from './antigravity';

export const installGeminiCliEarly = installAntigravityEarly;
export const installGeminiCliLate = installAntigravityLate;
export const uninitGeminiCli = uninitAntigravity;

export function printGeminiCliNextSteps(): void {
  console.log('\n  Done! Restart Gemini CLI for the MCP server to load.');
  console.log('  KiroGraph instructions are in GEMINI.md\n');
}
