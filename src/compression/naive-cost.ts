/**
 * Naive cost estimator for KiroGraph MCP tools.
 *
 * Estimates how many tokens the agent would have consumed doing the same
 * work without KiroGraph (reading files, running grep, etc.).
 *
 * These are conservative estimates based on typical agent behavior:
 * - kirograph_context: agent would read 5-10 files fully to orient
 * - kirograph_search: agent would run grep/ripgrep across the project
 * - kirograph_callers/callees: agent would grep for the symbol name + read each file
 * - kirograph_impact: agent would trace callers recursively (multiple grep + read cycles)
 * - kirograph_node: agent would read the full file containing the symbol
 * - kirograph_files: agent would run find/ls -R
 * - kirograph_status: agent would check file counts, run wc, etc.
 * - kirograph_hotspots/surprising/dead_code: not feasible manually (infinite cost → cap at 5x)
 */

import { estimateTokens } from './index';

/** Average tokens per file read (medium-sized source file ~200 lines) */
const AVG_FILE_TOKENS = 1500;

/** Average tokens for a grep result across a medium project */
const AVG_GREP_TOKENS = 800;

/** Average tokens for ls -R or find output on a medium project */
const AVG_FIND_TOKENS = 2000;

/**
 * Estimate the naive token cost (what the agent would have spent without KiroGraph).
 *
 * @param toolName - The MCP tool that was called
 * @param outputTokens - Actual tokens in the tool's response
 * @param args - The tool arguments (for context-aware estimation)
 * @returns Estimated naive cost in tokens, or null if not estimable
 */
export function estimateNaiveCost(toolName: string, outputTokens: number, args?: Record<string, unknown>): number | null {
  switch (toolName) {
    case 'kirograph_context': {
      // Agent would read ~5-10 files to understand a task area
      const maxNodes = (args?.maxNodes as number) || 20;
      const filesEstimate = Math.min(Math.ceil(maxNodes / 2), 10);
      return filesEstimate * AVG_FILE_TOKENS;
    }

    case 'kirograph_search': {
      // Agent would run grep/ripgrep and read through results
      const limit = (args?.limit as number) || 10;
      // grep output + reading top matches
      return AVG_GREP_TOKENS + Math.min(limit, 5) * (AVG_FILE_TOKENS / 3);
    }

    case 'kirograph_callers': {
      // Agent would grep for the symbol, then read each calling file
      const limit = (args?.limit as number) || 20;
      const callersEstimate = Math.min(limit, 10);
      return AVG_GREP_TOKENS + callersEstimate * (AVG_FILE_TOKENS / 2);
    }

    case 'kirograph_callees': {
      // Agent would read the function body + grep for each called symbol
      return AVG_FILE_TOKENS + AVG_GREP_TOKENS * 3;
    }

    case 'kirograph_impact': {
      // Agent would need multiple rounds of grep + read (recursive)
      const depth = (args?.depth as number) || 2;
      return (AVG_GREP_TOKENS + AVG_FILE_TOKENS * 3) * depth;
    }

    case 'kirograph_node': {
      // Agent would read the full file to find the symbol
      return AVG_FILE_TOKENS;
    }

    case 'kirograph_files': {
      // Agent would run find or ls -R
      return AVG_FIND_TOKENS;
    }

    case 'kirograph_status': {
      // Agent would run multiple commands (wc -l, find, du, etc.)
      return 500;
    }

    case 'kirograph_path': {
      // Agent would need to manually trace connections — multiple grep + read cycles
      return AVG_GREP_TOKENS * 4 + AVG_FILE_TOKENS * 3;
    }

    case 'kirograph_type_hierarchy': {
      // Agent would grep for extends/implements, read each file
      return AVG_GREP_TOKENS * 3 + AVG_FILE_TOKENS * 2;
    }

    case 'kirograph_dead_code': {
      // Not feasible manually — would require reading every file and cross-referencing
      // Cap at 5x the output (conservative)
      return Math.max(outputTokens * 5, AVG_FILE_TOKENS * 10);
    }

    case 'kirograph_circular_deps': {
      // Not feasible manually — would require building a full import graph
      return Math.max(outputTokens * 5, AVG_FILE_TOKENS * 8);
    }

    case 'kirograph_hotspots': {
      // Not feasible manually — would require counting edges for every symbol
      return Math.max(outputTokens * 5, AVG_FILE_TOKENS * 10);
    }

    case 'kirograph_surprising': {
      // Not feasible manually
      return Math.max(outputTokens * 5, AVG_FILE_TOKENS * 10);
    }

    case 'kirograph_architecture':
    case 'kirograph_coupling':
    case 'kirograph_package': {
      // Architecture analysis is not feasible manually
      return Math.max(outputTokens * 4, AVG_FILE_TOKENS * 5);
    }

    case 'kirograph_diff': {
      // Agent would need to compare file lists and grep for symbols
      return Math.max(outputTokens * 3, AVG_FILE_TOKENS * 5);
    }

    // kirograph_exec and kirograph_gain are tracked separately
    default:
      return null;
  }
}
