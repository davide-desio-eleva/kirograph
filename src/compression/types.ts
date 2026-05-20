/**
 * KiroGraph Output Compression — Type Definitions
 */

export interface CompressionResult {
  /** Compressed output text */
  output: string;
  /** Estimated original token count */
  originalTokens: number;
  /** Estimated compressed token count */
  compressedTokens: number;
  /** Percentage saved (0-100) */
  savings: number;
  /** Which strategy was applied */
  strategy: string;
  /** The detected command family */
  commandFamily: string;
}

export interface CompressorOptions {
  /** Compression aggressiveness */
  level: 'normal' | 'aggressive' | 'ultra';
  /** Max output tokens (truncate beyond this) */
  maxOutputTokens?: number;
  /** Never compress error details (default: true) */
  preserveErrors?: boolean;
}

export interface FilterResult {
  output: string;
  strategy: string;
}

export interface CommandFilter {
  /** Name of this filter family */
  name: string;
  /** Test if this filter handles the given command */
  matches(command: string): boolean;
  /** Apply the filter to raw output */
  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult;
}

export interface TokenSavingsRecord {
  id?: number;
  timestamp: number;
  command: string;
  originalTokens: number;
  compressedTokens: number;
  strategy: string;
  sessionId: string;
  /** Source of the saving: 'exec' for compression, 'graph' for MCP graph tools */
  source?: 'exec' | 'graph';
}
