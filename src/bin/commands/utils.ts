import * as path from 'path';
import { dim, reset, violet, bold, green, value } from '../ui';

export async function openProject(projectPath?: string): Promise<{ cg: any; target: string }> {
  const KiroGraph = (await import('../../index')).default;
  const target = path.resolve(projectPath ?? process.cwd());
  const cg = await KiroGraph.open(target);
  return { cg, target };
}

export function warnFallback(fallback: string | null): void {
  if (fallback) console.warn(`  \x1b[33m⚠ Engine fallback: ${fallback}\x1b[0m`);
}

export function formatSyncCounts(result: { added: unknown[]; modified: unknown[]; removed: unknown[]; duration: number }): string {
  return `  ${green}✓${reset} ${dim}added${reset} ${value(String(result.added.length))}  ${dim}modified${reset} ${value(String(result.modified.length))}  ${dim}removed${reset} ${value(String(result.removed.length))}  ${dim}(${result.duration}ms)${reset}`;
}

/**
 * Track token savings for a CLI graph tool invocation.
 * Non-critical — silently ignores errors.
 */
export function trackCliToolSaving(projectRoot: string, toolName: string, output: string, args?: Record<string, unknown>): void {
  try {
    const { TokenTracker } = require('../../compression/tracker');
    const { estimateNaiveCost } = require('../../compression/naive-cost');
    const { estimateTokens } = require('../../compression/index');

    const outputTokens = estimateTokens(output);
    const naiveCost = estimateNaiveCost(toolName, outputTokens, args);
    if (naiveCost !== null && naiveCost > outputTokens) {
      const tracker = new TokenTracker(projectRoot);
      tracker.recordGraphSaving(toolName, outputTokens, naiveCost);
    }
  } catch { /* non-critical */ }
}
