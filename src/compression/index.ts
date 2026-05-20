/**
 * KiroGraph Output Compression Engine
 *
 * Filters and compresses command outputs to reduce token consumption.
 * Inspired by rtk (https://github.com/rtk-ai/rtk), implemented in pure TypeScript.
 */

import type { CompressionResult, CompressorOptions, CommandFilter } from './types';
import { gitFilter } from './filters/git';
import { testFilter } from './filters/test';
import { lintFilter } from './filters/lint';
import { filesFilter } from './filters/files';
import { dockerFilter } from './filters/docker';
import { packageFilter } from './filters/package';
import { awsFilter } from './filters/aws';
import { githubFilter } from './filters/github';
import { miscFilter } from './filters/misc';
import { genericFilter } from './filters/generic';

export type { CompressionResult, CompressorOptions, CommandFilter, TokenSavingsRecord } from './types';

// ── Filter registry (order matters — first match wins) ────────────────────────

const FILTERS: CommandFilter[] = [
  gitFilter,
  testFilter,
  lintFilter,
  miscFilter,      // grep, diff, curl, wget, playwright, prisma
  filesFilter,
  dockerFilter,
  packageFilter,
  awsFilter,
  githubFilter,
  genericFilter,   // Always last — catches everything
];

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Rough token count estimation.
 * Uses the ~4 chars per token heuristic for English/code text.
 * Good enough for savings tracking without pulling in a tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Approximate: 1 token ≈ 4 characters for code/English mix
  return Math.ceil(text.length / 4);
}

// ── Main compress function ────────────────────────────────────────────────────

const DEFAULT_OPTIONS: CompressorOptions = {
  level: 'normal',
  preserveErrors: true,
};

/**
 * Compress command output using the appropriate filter.
 *
 * @param command - The shell command that was executed
 * @param rawOutput - The raw stdout/stderr output
 * @param opts - Compression options
 * @returns Compression result with output, token counts, and strategy info
 */
export function compress(command: string, rawOutput: string, opts?: Partial<CompressorOptions>): CompressionResult {
  const options: CompressorOptions = { ...DEFAULT_OPTIONS, ...opts };

  // Empty output — nothing to compress
  if (!rawOutput || !rawOutput.trim()) {
    return {
      output: rawOutput || '',
      originalTokens: 0,
      compressedTokens: 0,
      savings: 0,
      strategy: 'empty',
      commandFamily: 'none',
    };
  }

  const originalTokens = estimateTokens(rawOutput);

  // Find matching filter
  const filter = FILTERS.find(f => f.matches(command));
  if (!filter) {
    // Should never happen since genericFilter always matches
    return {
      output: rawOutput,
      originalTokens,
      compressedTokens: originalTokens,
      savings: 0,
      strategy: 'none',
      commandFamily: 'unknown',
    };
  }

  // Check if output looks like an error and preserveErrors is on
  if (options.preserveErrors && isErrorOutput(rawOutput, command)) {
    // Still apply filter but with less aggressive truncation
    const result = filter.filter(command, rawOutput, 'normal');
    const compressedTokens = estimateTokens(result.output);
    return {
      output: result.output,
      originalTokens,
      compressedTokens,
      savings: Math.round(((originalTokens - compressedTokens) / originalTokens) * 100),
      strategy: result.strategy + ':error-preserved',
      commandFamily: filter.name,
    };
  }

  // Apply filter
  const result = filter.filter(command, rawOutput, options.level);
  let output = result.output;

  // Apply maxOutputTokens truncation if specified
  if (options.maxOutputTokens && estimateTokens(output) > options.maxOutputTokens) {
    const maxChars = options.maxOutputTokens * 4;
    output = output.slice(0, maxChars) + '\n…(truncated to token limit)';
  }

  const compressedTokens = estimateTokens(output);
  const savings = originalTokens > 0
    ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100)
    : 0;

  return {
    output,
    originalTokens,
    compressedTokens,
    savings: Math.max(0, savings), // Never negative
    strategy: result.strategy,
    commandFamily: filter.name,
  };
}

/**
 * Detect the command family without running the full filter.
 * Useful for analytics and reporting.
 */
export function detectCommandFamily(command: string): string {
  for (const filter of FILTERS) {
    if (filter !== genericFilter && filter.matches(command)) {
      return filter.name;
    }
  }
  return 'other';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Heuristic: does this output look like a command failure?
 * If so, we want to preserve more detail.
 */
function isErrorOutput(output: string, _command: string): boolean {
  const errorIndicators = [
    /^error/im,
    /\bfailed\b/i,
    /\bpanic\b/i,
    /\bfatal\b/i,
    /exit\s+code\s+[1-9]/i,
    /\bException\b/,
    /\bTraceback\b/,
    /\bsegfault\b/i,
    /\bSIGSEGV\b/,
    /\bSIGABRT\b/,
  ];

  // Only consider it an error if the indicators appear near the start or end
  const head = output.slice(0, 500);
  const tail = output.slice(-500);
  const sample = head + tail;

  return errorIndicators.some(re => re.test(sample));
}
