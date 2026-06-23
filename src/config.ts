/**
 * KiroGraph Config System
 *
 * Mirrors CodeGraph src/config.ts — load, save, validate, and provide defaults
 * for KiroGraph configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { logWarn, logError } from './errors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KiroGraphConfig {
  version: number;
  languages: string[];
  include: string[];
  exclude: string[];
  maxFileSize: number;
  extractDocstrings: boolean;
  trackCallSites: boolean;
  // Parity fields:
  enableEmbeddings: boolean;
  embeddingModel: string;
  embeddingDim: number;
  /** @deprecated Use semanticEngine instead. Kept for backwards compatibility. */
  useVecIndex: boolean;
  semanticEngine: 'cosine' | 'turboquant' | 'turbovec' | 'sqlite-vec' | 'orama' | 'pglite' | 'lancedb' | 'qdrant' | 'typesense';
  /** Apply TurboQuant ANN index to memory observations and doc sections. Default: false. */
  turboquantMemDocs: boolean;
  /** TurboQuant bits per coordinate (1–8). Controls compression/quality tradeoff. Default: 3 (≈25×). */
  turboquantBits: number;
  /** Apply TurboVec ANN index to memory observations and doc sections. Default: false. */
  turbovecMemDocs: boolean;
  /** TurboVec bits per coordinate (2, 3, or 4). Controls compression/quality tradeoff. Default: 4. */
  turbovecBits: number;
  typesenseDashboard: boolean;
  qdrantDashboard: boolean;
  minLogLevel: 'debug' | 'info' | 'warn' | 'error';
  frameworkHints: string[];
  fuzzyResolutionThreshold: number; // 0.0–1.0
  /** Enable architecture analysis (package graph + layer detection). Default: false. */
  enableArchitecture: boolean;
  /**
   * User-defined layer → glob pattern overrides.
   * When set, config-defined layers win over auto-detected ones.
   * Example: { "api": ["src/routes/**", "src/controllers/**"] }
   */
  architectureLayers?: Record<string, string[]>;
  /** Agent communication style injected at agentSpawn. Default: 'off'. */
  cavemanMode: 'off' | 'lite' | 'full' | 'ultra';
  /** Shell compression level for kirograph_exec. 'off' disables the hook/steering. Default: 'normal'. */
  shellCompressionLevel: 'off' | 'normal' | 'aggressive' | 'ultra';
  /**
   * Number of pending (unindexed) files above which kirograph_status warns the agent.
   * Set to 0 to disable the warning. Default: 10.
   */
  syncWarningThreshold: number;
  /** Enable persistent cross-session memory. Default: false. */
  enableMemory: boolean;
  /** FTS/vector blend for memory search: 0 = FTS only, 1 = vector only. Default: 0.5. */
  memorySearchAlpha: number;
  /** Store uncompressed originals when caveman is on. Default: false. */
  memoryKeepRaw: boolean;
  /** Auto-prune threshold (max observations). 0 = no limit. Default: 10000. */
  memoryMaxObservations: number;
  /** Seconds of inactivity before auto-closing a session. Default: 7200. */
  memorySessionTimeout: number;
  /** Max observations shown in kirograph_context. Default: 3. */
  memoryContextLimit: number;
  /** Min relevance score to include memory in context. Default: 0.3. */
  memoryContextThreshold: number;
  /** Glob patterns for paths to never capture in memory. Default: []. */
  memoryExcludePatterns: string[];
  /** Enable watchmen — auto-synthesize workspace briefs from memory observations. Requires enableMemory. Default: false. */
  enableWatchmen: boolean;
  /** Minimum new observations since last synthesis before watchmenReady fires. Default: 5. */
  watchmenThreshold: number;
  /**
   * How synthesis is performed.
   * 'local' — runs a local HuggingFace model via @huggingface/transformers (no API cost, works for all tools).
   * 'agent' — delegates to the active AI agent via askAgent hook (Kiro only, consumes agent tokens).
   * Default: 'local'.
   */
  watchmenSynthesisMode: 'local' | 'agent';
  /** HuggingFace model ID for local synthesis. Only used when watchmenSynthesisMode is 'local'. Default: 'onnx-community/gemma-4-E4B-it-ONNX'. */
  watchmenLocalModel: string;
  /** Enable documentation indexing and navigation. Default: false. */
  enableDocs: boolean;
  /** Glob patterns for documentation files to include. */
  docsInclude: string[];
  /** Glob patterns for documentation files to exclude. */
  docsExclude: string[];
  /** Enable auto-linking of doc sections to code symbols. Default: true. */
  docsLinkCode: boolean;
  /** Max doc sections to include in kirograph_context. 0 = disabled. Default: 0. */
  docsContextLimit: number;
  /** Min relevance score to include a doc section in context. Default: 0.3. */
  docsContextThreshold: number;
  /** Max file size for doc files (bytes). Default: 1MB. */
  docsMaxFileSize: number;
  /** Summarization strategy. Default: 'first-sentence'. */
  docsSummarization: 'embedding' | 'first-sentence' | 'off';
  /** Enable LLM-maintained wiki (entity pages in .kirograph/wiki/). Default: false. */
  enableWiki: boolean;
  /** Wiki synthesis mode. Default: 'agent'. */
  wikiSynthesisMode: 'agent' | 'local';
  /** HuggingFace model for local wiki synthesis. */
  wikiLocalModel: string;
  /** Glob patterns for auto-ingest wiki sources. Default: ['docs/']. */
  wikiSources: string[];
  /** Auto-resolve wiki conflicts by source date. Default: false. */
  wikiAutoResolveConflicts: boolean;
  /** Lint frequency: 'weekly' (every ~20 sessions) or 'off'. Default: 'off'. */
  wikiLintFrequency: 'weekly' | 'off';
  /** Max wiki pages to include in kirograph_context. Default: 3. */
  wikiContextLimit: number;
  /** Min FTS score to include wiki page in context. Default: 0.4. */
  wikiContextThreshold: number;
  /** Enable tabular data indexing and querying. Default: false. */
  enableData: boolean;
  /** Glob patterns for data files to include. */
  dataInclude: string[];
  /** Glob patterns for data files to exclude. */
  dataExclude: string[];
  /** Enable auto-linking of data files to code symbols. Default: true. */
  dataLinkCode: boolean;
  /** Max datasets to include in kirograph_context. 0 = disabled. Default: 0. */
  dataContextLimit: number;
  /** Max file size for data files (bytes). Default: 50MB. */
  dataMaxFileSize: number;
  /** Max rows to index per file. Default: 1,000,000. */
  dataMaxRows: number;
  /** Max rows returned per query. Default: 500. */
  dataQueryLimit: number;
  /** Max token budget per response. Default: 8000. */
  dataMaxResponseTokens: number;
  /**
   * [EXPERIMENTAL] Enable visual PDF search via PixelRAG bridge. Requires Python 3.10+,
   * enableData + dataInstallPdf, and ~6 GB free disk + 8 GB RAM. Default: false.
   */
  enableVisualPDF: boolean;
  /** Port for the PixelRAG local server. Default: 30001. */
  pixelragPort: number;
  /** Enable security analysis (dependency scanning + vulnerability detection). Default: false. */
  enableSecurity: boolean;
  /** Vulnerability databases to query. Default: ['OSV']. */
  securityDatabases: string[];
  /** Enable AST-level structural pattern matching (SAST) during indexing. Default: false. */
  enablePatterns: boolean;
  /** Enable code health tools (hotspots, dead code, change tracking). Default: true. */
  enableCodeHealth: boolean;
  /** Enable advanced analysis tools (type hierarchies, flows, communities, refactor). Default: true. */
  enableAdvancedAnalysis: boolean;
  /** Enable agent utility tools (file caching, budget tracking). Default: true. */
  enableAgentUtils: boolean;
  /** Enable general-purpose compression tool (kirograph_compress). Default: false. */
  enableGeneralCompression: boolean;
  /** Derived from shellCompressionLevel — true when compression is enabled. Controls kirograph_exec. */
  enableShellExec: boolean;
  /** Path to a directory of user-supplied YAML rule files. Merged with bundled library (user rules win on id conflict). Default: undefined. */
  patternLibraryPath: string | undefined;
  /** Minimum severity level for storing pattern matches during index-time analysis. Default: 'low'. */
  patternSeverityThreshold: 'critical' | 'high' | 'medium' | 'low';
  /** Auto-run vulnerability enrichment after manifest parsing. Default: true. */
  securityAutoEnrich: boolean;
  /** Max age in days for vulnerability data before showing a staleness warning. Default: 7. */
  securityEnrichMaxAgeDays: number;
  /**
   * License policy for dependency compliance.
   * deny: licenses to block (build fails / command exits non-zero).
   * warn: licenses to flag as warnings.
   * Patterns support wildcards: GPL-* matches GPL-2.0, GPL-3.0, etc.
   * Default: { deny: [], warn: [] }.
   */
  securityLicensePolicy: {
    deny: string[];
    warn: string[];
  };
  /** Context budget governance settings. */
  contextBudget?: {
    maxTokensPerSession: number;
    warnAt: number;
    throttleAt: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KIROGRAPH_DIR = '.kirograph';
const CONFIG_FILE = 'config.json';

const KNOWN_FIELDS = new Set<string>([
  'version', 'languages', 'include', 'exclude', 'maxFileSize',
  'extractDocstrings', 'trackCallSites', 'enableEmbeddings', 'embeddingModel', 'embeddingDim',
  'useVecIndex', 'semanticEngine', 'turboquantMemDocs', 'turboquantBits', 'turbovecMemDocs', 'turbovecBits', 'typesenseDashboard', 'qdrantDashboard',
  'minLogLevel', 'frameworkHints', 'fuzzyResolutionThreshold',
  'enableArchitecture', 'architectureLayers', 'cavemanMode', 'shellCompressionLevel', 'syncWarningThreshold',
  'enableMemory', 'memorySearchAlpha', 'memoryKeepRaw', 'memoryMaxObservations',
  'memorySessionTimeout', 'memoryContextLimit', 'memoryContextThreshold', 'memoryExcludePatterns',
  'enableWatchmen', 'watchmenThreshold', 'watchmenSynthesisMode', 'watchmenLocalModel',
  'enableWiki', 'wikiSynthesisMode', 'wikiLocalModel', 'wikiSources',
  'wikiAutoResolveConflicts', 'wikiLintFrequency', 'wikiContextLimit', 'wikiContextThreshold',
  'enableDocs', 'docsInclude', 'docsExclude', 'docsLinkCode',
  'docsContextLimit', 'docsContextThreshold', 'docsMaxFileSize', 'docsSummarization',
  'enableData', 'dataInclude', 'dataExclude', 'dataLinkCode',
  'dataContextLimit', 'dataMaxFileSize', 'dataMaxRows', 'dataQueryLimit', 'dataMaxResponseTokens',
  'enableVisualPDF', 'pixelragPort',
  'enableSecurity', 'securityDatabases', 'securityAutoEnrich', 'securityEnrichMaxAgeDays', 'securityLicensePolicy',
  'enablePatterns', 'patternLibraryPath', 'patternSeverityThreshold',
  'enableCodeHealth', 'enableAdvancedAnalysis', 'enableAgentUtils', 'enableGeneralCompression',
  'contextBudget',
  // Legacy aliases / derived fields (accepted but ignored or recomputed)
  'enableCompression', 'compressionLevel', 'enableShellExec',
]);

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// ── ReDoS-safe regex check ────────────────────────────────────────────────────

/**
 * Returns false if the pattern is potentially dangerous (ReDoS risk) or too long.
 * Checks for catastrophic backtracking patterns like (a+)+ or (a|a)+.
 */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 100) return false;
  // Detect nested quantifiers: (x+)+ or (x*)+ or (x+)* etc.
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return false;
  // Detect alternation with overlap: (a|a)+ style
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) return false;
  return true;
}

// ── Default config ────────────────────────────────────────────────────────────

export function createDefaultConfig(_projectRoot?: string): KiroGraphConfig {
  return {
    version: 2,
    languages: [],
    include: [],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '*.min.js', '**/.kirograph/**'],
    maxFileSize: 1_048_576,
    extractDocstrings: false,
    trackCallSites: false,
    enableEmbeddings: false,
    embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
    embeddingDim: 768,
    useVecIndex: false,
    semanticEngine: 'cosine',
    turboquantMemDocs: false,
    turboquantBits: 3,
    turbovecMemDocs: false,
    turbovecBits: 4,
    typesenseDashboard: false,
    qdrantDashboard: false,
    minLogLevel: 'warn',
    frameworkHints: [],
    fuzzyResolutionThreshold: 0.5,
    enableArchitecture: false,
    cavemanMode: 'off',
    shellCompressionLevel: 'normal',
    syncWarningThreshold: 10,
    enableMemory: false,
    memorySearchAlpha: 0.5,
    memoryKeepRaw: false,
    memoryMaxObservations: 10000,
    memorySessionTimeout: 7200,
    memoryContextLimit: 3,
    memoryContextThreshold: 0.3,
    memoryExcludePatterns: [],
    enableWatchmen: false,
    watchmenThreshold: 5,
    watchmenSynthesisMode: 'local',
    watchmenLocalModel: 'onnx-community/gemma-4-E4B-it-ONNX',
    enableWiki: false,
    wikiSynthesisMode: 'agent' as const,
    wikiLocalModel: 'onnx-community/gemma-4-E4B-it-ONNX',
    wikiSources: ['docs/'],
    wikiAutoResolveConflicts: false,
    wikiLintFrequency: 'off' as const,
    wikiContextLimit: 3,
    wikiContextThreshold: 0.4,
    enableDocs: false,
    docsInclude: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.asciidoc', '**/*.rdoc', '**/*.org', '**/*.cheatmd', 'docs/**/*.txt', 'docs/**/*.html'],
    docsExclude: ['node_modules/**', '**/CHANGELOG*', '**/LICENSE*', '**/CHANGES*', 'dist/**', 'build/**', 'coverage/**', '.git/**', '**/generated/**', '**/auto-generated/**', '**/vendor/**', '_build/**'],
    docsLinkCode: true,
    docsContextLimit: 0,
    docsContextThreshold: 0.3,
    docsMaxFileSize: 1_048_576,
    docsSummarization: 'first-sentence',
    enableData: false,
    dataInclude: ['**/*.csv', '**/*.tsv', '**/*.jsonl', '**/*.ndjson', '**/*.xlsx', '**/*.xls', '**/*.parquet', 'data/**/*.json', '**/*.pdf'],
    dataExclude: ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/tsconfig.json', '**/jsconfig.json', 'coverage/**', '**/generated/**'],
    dataLinkCode: true,
    dataContextLimit: 0,
    dataMaxFileSize: 52_428_800,
    dataMaxRows: 1_000_000,
    dataQueryLimit: 500,
    dataMaxResponseTokens: 8000,
    enableVisualPDF: false,
    pixelragPort: 30001,
    enableSecurity: false,
    securityDatabases: ['OSV'],
    securityAutoEnrich: true,
    securityEnrichMaxAgeDays: 7,
    securityLicensePolicy: { deny: [], warn: [] },
    enablePatterns: false,
    patternLibraryPath: undefined,
    patternSeverityThreshold: 'low',
    enableCodeHealth: true,
    enableAdvancedAnalysis: true,
    enableAgentUtils: true,
    enableGeneralCompression: false,
    enableShellExec: true,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateConfig(config: unknown): KiroGraphConfig {
  const defaults = createDefaultConfig();

  if (typeof config !== 'object' || config === null) {
    return defaults;
  }

  const raw = config as Record<string, unknown>;

  // Warn about unknown fields
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      logWarn(`Unknown config field: ${key}`);
    }
  }

  // Validate and coerce each field
  const version = typeof raw.version === 'number' ? raw.version : defaults.version;
  const languages = Array.isArray(raw.languages) && raw.languages.every(l => typeof l === 'string')
    ? (raw.languages as string[])
    : defaults.languages;
  const maxFileSize = typeof raw.maxFileSize === 'number' && raw.maxFileSize > 0
    ? raw.maxFileSize
    : defaults.maxFileSize;
  const extractDocstrings = typeof raw.extractDocstrings === 'boolean'
    ? raw.extractDocstrings
    : defaults.extractDocstrings;
  const trackCallSites = typeof raw.trackCallSites === 'boolean'
    ? raw.trackCallSites
    : defaults.trackCallSites;
  const enableEmbeddings = typeof raw.enableEmbeddings === 'boolean'
    ? raw.enableEmbeddings
    : defaults.enableEmbeddings;
  const embeddingModel = typeof raw.embeddingModel === 'string' && raw.embeddingModel.length > 0
    ? raw.embeddingModel
    : defaults.embeddingModel;
  const embeddingDim = typeof raw.embeddingDim === 'number' && raw.embeddingDim > 0
    ? raw.embeddingDim
    : defaults.embeddingDim;
  const useVecIndex = typeof raw.useVecIndex === 'boolean'
    ? raw.useVecIndex
    : defaults.useVecIndex;
  const SEMANTIC_ENGINES = new Set(['cosine', 'turboquant', 'turbovec', 'sqlite-vec', 'orama', 'pglite', 'lancedb', 'qdrant', 'typesense']);
  // useVecIndex is a legacy alias: if set and no explicit semanticEngine, map it
  const semanticEngine = typeof raw.semanticEngine === 'string' && SEMANTIC_ENGINES.has(raw.semanticEngine)
    ? (raw.semanticEngine as KiroGraphConfig['semanticEngine'])
    : useVecIndex ? 'sqlite-vec' : defaults.semanticEngine;
  const turboquantMemDocs = typeof raw.turboquantMemDocs === 'boolean'
    ? raw.turboquantMemDocs
    : defaults.turboquantMemDocs;
  const turboquantBits = typeof raw.turboquantBits === 'number'
    && raw.turboquantBits >= 1 && raw.turboquantBits <= 8
    ? Math.round(raw.turboquantBits)
    : defaults.turboquantBits;
  const turbovecMemDocs = typeof raw.turbovecMemDocs === 'boolean'
    ? raw.turbovecMemDocs
    : defaults.turbovecMemDocs;
  const TURBOVEC_BIT_WIDTHS = new Set([2, 3, 4]);
  const turbovecBits = typeof raw.turbovecBits === 'number' && TURBOVEC_BIT_WIDTHS.has(Math.round(raw.turbovecBits))
    ? Math.round(raw.turbovecBits)
    : defaults.turbovecBits;
  const typesenseDashboard = typeof raw.typesenseDashboard === 'boolean'
    ? raw.typesenseDashboard
    : defaults.typesenseDashboard;
  const qdrantDashboard = typeof raw.qdrantDashboard === 'boolean'
    ? raw.qdrantDashboard
    : defaults.qdrantDashboard;
  const minLogLevel = typeof raw.minLogLevel === 'string' && LOG_LEVELS.has(raw.minLogLevel)
    ? (raw.minLogLevel as KiroGraphConfig['minLogLevel'])
    : defaults.minLogLevel;
  const frameworkHints = Array.isArray(raw.frameworkHints) && raw.frameworkHints.every(h => typeof h === 'string')
    ? (raw.frameworkHints as string[])
    : defaults.frameworkHints;
  const fuzzyResolutionThreshold = typeof raw.fuzzyResolutionThreshold === 'number'
    && raw.fuzzyResolutionThreshold >= 0
    && raw.fuzzyResolutionThreshold <= 1
    ? raw.fuzzyResolutionThreshold
    : defaults.fuzzyResolutionThreshold;
  const enableArchitecture = typeof raw.enableArchitecture === 'boolean'
    ? raw.enableArchitecture
    : defaults.enableArchitecture;
  const architectureLayers = _validateArchitectureLayers(raw.architectureLayers);
  const CAVEMAN_MODES = new Set(['off', 'lite', 'full', 'ultra']);
  const cavemanMode = typeof raw.cavemanMode === 'string' && CAVEMAN_MODES.has(raw.cavemanMode)
    ? (raw.cavemanMode as KiroGraphConfig['cavemanMode'])
    : defaults.cavemanMode;
  const COMPRESSION_LEVELS = new Set(['off', 'normal', 'aggressive', 'ultra']);
  // Support legacy field names: enableCompression (boolean) and compressionLevel (string)
  let shellCompressionLevel: KiroGraphConfig['shellCompressionLevel'];
  if (typeof raw.shellCompressionLevel === 'string' && COMPRESSION_LEVELS.has(raw.shellCompressionLevel)) {
    shellCompressionLevel = raw.shellCompressionLevel as KiroGraphConfig['shellCompressionLevel'];
  } else if (typeof raw.compressionLevel === 'string' && COMPRESSION_LEVELS.has(raw.compressionLevel)) {
    shellCompressionLevel = raw.compressionLevel as KiroGraphConfig['shellCompressionLevel'];
  } else if (typeof raw.enableCompression === 'boolean') {
    shellCompressionLevel = raw.enableCompression ? 'normal' : 'off';
  } else {
    shellCompressionLevel = defaults.shellCompressionLevel;
  }
  const syncWarningThreshold = typeof raw.syncWarningThreshold === 'number' && raw.syncWarningThreshold >= 0
    ? Math.round(raw.syncWarningThreshold)
    : defaults.syncWarningThreshold;

  // ── Memory config ─────────────────────────────────────────────────────────
  const enableMemory = typeof raw.enableMemory === 'boolean'
    ? raw.enableMemory
    : defaults.enableMemory;
  const memorySearchAlpha = typeof raw.memorySearchAlpha === 'number'
    && raw.memorySearchAlpha >= 0 && raw.memorySearchAlpha <= 1
    ? raw.memorySearchAlpha
    : defaults.memorySearchAlpha;
  const memoryKeepRaw = typeof raw.memoryKeepRaw === 'boolean'
    ? raw.memoryKeepRaw
    : defaults.memoryKeepRaw;
  const memoryMaxObservations = typeof raw.memoryMaxObservations === 'number' && raw.memoryMaxObservations >= 0
    ? Math.round(raw.memoryMaxObservations)
    : defaults.memoryMaxObservations;
  const memorySessionTimeout = typeof raw.memorySessionTimeout === 'number' && raw.memorySessionTimeout > 0
    ? Math.round(raw.memorySessionTimeout)
    : defaults.memorySessionTimeout;
  const memoryContextLimit = typeof raw.memoryContextLimit === 'number' && raw.memoryContextLimit >= 0
    ? Math.round(raw.memoryContextLimit)
    : defaults.memoryContextLimit;
  const memoryContextThreshold = typeof raw.memoryContextThreshold === 'number'
    && raw.memoryContextThreshold >= 0 && raw.memoryContextThreshold <= 1
    ? raw.memoryContextThreshold
    : defaults.memoryContextThreshold;
  const memoryExcludePatterns = Array.isArray(raw.memoryExcludePatterns)
    && raw.memoryExcludePatterns.every((p: unknown) => typeof p === 'string')
    ? (raw.memoryExcludePatterns as string[])
    : defaults.memoryExcludePatterns;

  // ── Watchmen config ───────────────────────────────────────────────────────
  const enableWatchmen = typeof raw.enableWatchmen === 'boolean'
    ? raw.enableWatchmen
    : defaults.enableWatchmen;
  const watchmenThreshold = typeof raw.watchmenThreshold === 'number' && raw.watchmenThreshold > 0
    ? Math.round(raw.watchmenThreshold)
    : defaults.watchmenThreshold;
  const WATCHMEN_SYNTHESIS_MODES = new Set(['local', 'agent']);
  const watchmenSynthesisMode = typeof raw.watchmenSynthesisMode === 'string' && WATCHMEN_SYNTHESIS_MODES.has(raw.watchmenSynthesisMode)
    ? (raw.watchmenSynthesisMode as KiroGraphConfig['watchmenSynthesisMode'])
    : defaults.watchmenSynthesisMode;
  const watchmenLocalModel = typeof raw.watchmenLocalModel === 'string' && raw.watchmenLocalModel.length > 0
    ? raw.watchmenLocalModel
    : defaults.watchmenLocalModel;

  // ── Wiki config ───────────────────────────────────────────────────────────
  const enableWiki = typeof raw.enableWiki === 'boolean' ? raw.enableWiki : defaults.enableWiki;
  const wikiSynthesisMode = raw.wikiSynthesisMode === 'local' ? 'local' as const : 'agent' as const;
  const wikiLocalModel = typeof raw.wikiLocalModel === 'string' ? raw.wikiLocalModel : defaults.wikiLocalModel;
  const wikiSources = Array.isArray(raw.wikiSources) ? raw.wikiSources : defaults.wikiSources;
  const wikiAutoResolveConflicts = typeof raw.wikiAutoResolveConflicts === 'boolean' ? raw.wikiAutoResolveConflicts : defaults.wikiAutoResolveConflicts;
  const wikiLintFrequency = raw.wikiLintFrequency === 'weekly' ? 'weekly' as const : 'off' as const;
  const wikiContextLimit = typeof raw.wikiContextLimit === 'number' ? raw.wikiContextLimit : defaults.wikiContextLimit;
  const wikiContextThreshold = typeof raw.wikiContextThreshold === 'number' ? raw.wikiContextThreshold : defaults.wikiContextThreshold;

  // ── Docs config ───────────────────────────────────────────────────────────
  const enableDocs = typeof raw.enableDocs === 'boolean'
    ? raw.enableDocs
    : defaults.enableDocs;
  const docsInclude = Array.isArray(raw.docsInclude)
    && raw.docsInclude.every((p: unknown) => typeof p === 'string')
    ? (raw.docsInclude as string[])
    : defaults.docsInclude;
  const docsExclude = Array.isArray(raw.docsExclude)
    && raw.docsExclude.every((p: unknown) => typeof p === 'string')
    ? (raw.docsExclude as string[])
    : defaults.docsExclude;
  const docsLinkCode = typeof raw.docsLinkCode === 'boolean'
    ? raw.docsLinkCode
    : defaults.docsLinkCode;
  const docsContextLimit = typeof raw.docsContextLimit === 'number' && raw.docsContextLimit >= 0
    ? Math.round(raw.docsContextLimit)
    : defaults.docsContextLimit;
  const docsContextThreshold = typeof raw.docsContextThreshold === 'number'
    && raw.docsContextThreshold >= 0 && raw.docsContextThreshold <= 1
    ? raw.docsContextThreshold
    : defaults.docsContextThreshold;
  const docsMaxFileSize = typeof raw.docsMaxFileSize === 'number' && raw.docsMaxFileSize > 0
    ? raw.docsMaxFileSize
    : defaults.docsMaxFileSize;
  const DOCS_SUMMARIZATION_MODES = new Set(['embedding', 'first-sentence', 'off']);
  const docsSummarization = typeof raw.docsSummarization === 'string' && DOCS_SUMMARIZATION_MODES.has(raw.docsSummarization)
    ? (raw.docsSummarization as KiroGraphConfig['docsSummarization'])
    : defaults.docsSummarization;

  // ── Data config ───────────────────────────────────────────────────────────
  const enableData = typeof raw.enableData === 'boolean' ? raw.enableData : defaults.enableData;
  const dataInclude = Array.isArray(raw.dataInclude) && raw.dataInclude.every((p: unknown) => typeof p === 'string')
    ? (raw.dataInclude as string[]) : defaults.dataInclude;
  const dataExclude = Array.isArray(raw.dataExclude) && raw.dataExclude.every((p: unknown) => typeof p === 'string')
    ? (raw.dataExclude as string[]) : defaults.dataExclude;
  const dataLinkCode = typeof raw.dataLinkCode === 'boolean' ? raw.dataLinkCode : defaults.dataLinkCode;
  const dataContextLimit = typeof raw.dataContextLimit === 'number' && raw.dataContextLimit >= 0
    ? Math.round(raw.dataContextLimit) : defaults.dataContextLimit;
  const dataMaxFileSize = typeof raw.dataMaxFileSize === 'number' && raw.dataMaxFileSize > 0
    ? raw.dataMaxFileSize : defaults.dataMaxFileSize;
  const dataMaxRows = typeof raw.dataMaxRows === 'number' && raw.dataMaxRows > 0
    ? Math.round(raw.dataMaxRows) : defaults.dataMaxRows;
  const dataQueryLimit = typeof raw.dataQueryLimit === 'number' && raw.dataQueryLimit > 0
    ? Math.min(Math.round(raw.dataQueryLimit), 500) : defaults.dataQueryLimit;
  const dataMaxResponseTokens = typeof raw.dataMaxResponseTokens === 'number' && raw.dataMaxResponseTokens > 0
    ? Math.round(raw.dataMaxResponseTokens) : defaults.dataMaxResponseTokens;

  // ── Visual PDF config ─────────────────────────────────────────────────────
  const enableVisualPDF = typeof raw.enableVisualPDF === 'boolean' ? raw.enableVisualPDF : defaults.enableVisualPDF;
  const pixelragPort = typeof raw.pixelragPort === 'number' && raw.pixelragPort > 0 && raw.pixelragPort < 65536
    ? Math.round(raw.pixelragPort) : defaults.pixelragPort;

  // ── Security config ───────────────────────────────────────────────────────
  let enableSecurity: boolean;
  if (typeof raw.enableSecurity === 'boolean') {
    enableSecurity = raw.enableSecurity;
  } else {
    if (raw.enableSecurity !== undefined) {
      logWarn('Invalid config field enableSecurity: expected boolean, applying default (false)');
    }
    enableSecurity = defaults.enableSecurity;
  }

  let securityAutoEnrich: boolean;
  if (typeof raw.securityAutoEnrich === 'boolean') {
    securityAutoEnrich = raw.securityAutoEnrich;
  } else {
    if (raw.securityAutoEnrich !== undefined) {
      logWarn('Invalid config field securityAutoEnrich: expected boolean, applying default (true)');
    }
    securityAutoEnrich = defaults.securityAutoEnrich;
  }

  let securityEnrichMaxAgeDays: number;
  if (typeof raw.securityEnrichMaxAgeDays === 'number' && raw.securityEnrichMaxAgeDays > 0) {
    securityEnrichMaxAgeDays = raw.securityEnrichMaxAgeDays;
  } else {
    if (raw.securityEnrichMaxAgeDays !== undefined) {
      logWarn('Invalid config field securityEnrichMaxAgeDays: expected positive number, applying default (7)');
    }
    securityEnrichMaxAgeDays = defaults.securityEnrichMaxAgeDays;
  }

  const SUPPORTED_SECURITY_DATABASES = new Set(['OSV']);
  let securityDatabases: string[];
  if (Array.isArray(raw.securityDatabases) && raw.securityDatabases.every((d: unknown) => typeof d === 'string')) {
    const valid = (raw.securityDatabases as string[]).filter(d => {
      if (!SUPPORTED_SECURITY_DATABASES.has(d)) {
        logWarn(`Unsupported security database "${d}" in securityDatabases, ignoring`);
        return false;
      }
      return true;
    });
    securityDatabases = valid.length > 0 ? valid : defaults.securityDatabases;
  } else {
    if (raw.securityDatabases !== undefined) {
      logWarn('Invalid config field securityDatabases: expected array of strings, applying default (["OSV"])');
    }
    securityDatabases = defaults.securityDatabases;
  }

  let securityLicensePolicy: KiroGraphConfig['securityLicensePolicy'];
  if (raw.securityLicensePolicy && typeof raw.securityLicensePolicy === 'object' && !Array.isArray(raw.securityLicensePolicy)) {
    const rawPolicy = raw.securityLicensePolicy as Record<string, unknown>;
    const deny = Array.isArray(rawPolicy.deny) && rawPolicy.deny.every((p: unknown) => typeof p === 'string')
      ? (rawPolicy.deny as string[])
      : defaults.securityLicensePolicy.deny;
    const warn = Array.isArray(rawPolicy.warn) && rawPolicy.warn.every((p: unknown) => typeof p === 'string')
      ? (rawPolicy.warn as string[])
      : defaults.securityLicensePolicy.warn;
    securityLicensePolicy = { deny, warn };
  } else {
    if (raw.securityLicensePolicy !== undefined) {
      logWarn('Invalid config field securityLicensePolicy: expected object with deny/warn arrays, applying default');
    }
    securityLicensePolicy = defaults.securityLicensePolicy;
  }

  // ── Patterns config ───────────────────────────────────────────────────────
  let enablePatterns: boolean;
  if (typeof raw.enablePatterns === 'boolean') {
    enablePatterns = raw.enablePatterns;
  } else {
    if (raw.enablePatterns !== undefined) {
      logWarn('Invalid config field enablePatterns: expected boolean, applying default (false)');
    }
    enablePatterns = defaults.enablePatterns;
  }

  let patternLibraryPath: string | undefined;
  if (raw.patternLibraryPath === undefined || raw.patternLibraryPath === null) {
    patternLibraryPath = undefined;
  } else if (typeof raw.patternLibraryPath === 'string') {
    patternLibraryPath = raw.patternLibraryPath;
  } else {
    logWarn('Invalid config field patternLibraryPath: expected string or undefined, applying default (undefined)');
    patternLibraryPath = defaults.patternLibraryPath;
  }

  const PATTERN_SEVERITY_LEVELS = new Set(['critical', 'high', 'medium', 'low']);
  let patternSeverityThreshold: KiroGraphConfig['patternSeverityThreshold'];
  if (typeof raw.patternSeverityThreshold === 'string' && PATTERN_SEVERITY_LEVELS.has(raw.patternSeverityThreshold)) {
    patternSeverityThreshold = raw.patternSeverityThreshold as KiroGraphConfig['patternSeverityThreshold'];
  } else {
    if (raw.patternSeverityThreshold !== undefined) {
      logWarn('Invalid config field patternSeverityThreshold: expected critical|high|medium|low, applying default (low)');
    }
    patternSeverityThreshold = defaults.patternSeverityThreshold;
  }

  // ── Tool group flags ──────────────────────────────────────────────────────
  const enableCodeHealth = typeof raw.enableCodeHealth === 'boolean'
    ? raw.enableCodeHealth
    : defaults.enableCodeHealth;
  const enableAdvancedAnalysis = typeof raw.enableAdvancedAnalysis === 'boolean'
    ? raw.enableAdvancedAnalysis
    : defaults.enableAdvancedAnalysis;
  const enableAgentUtils = typeof raw.enableAgentUtils === 'boolean'
    ? raw.enableAgentUtils
    : defaults.enableAgentUtils;
  const enableGeneralCompression = typeof raw.enableGeneralCompression === 'boolean'
    ? raw.enableGeneralCompression
    : defaults.enableGeneralCompression;

  // Dependency constraint: enableVisualPDF requires enableData
  if (enableVisualPDF && !enableData) {
    logWarn('enableVisualPDF requires enableData: true — visual PDF search disabled. Run kirograph install to configure.');
  }

  // Dependency constraint: enableSecurity requires enableArchitecture
  let finalEnableArchitecture = enableArchitecture;
  if (enableSecurity && !enableArchitecture) {
    logWarn('enableSecurity requires enableArchitecture \u2014 auto-enabling architecture analysis');
    finalEnableArchitecture = true;
  }

  // ── Context budget config ─────────────────────────────────────────────────
  let contextBudget: KiroGraphConfig['contextBudget'] | undefined;
  if (raw.contextBudget && typeof raw.contextBudget === 'object' && !Array.isArray(raw.contextBudget)) {
    const cb = raw.contextBudget as Record<string, unknown>;
    contextBudget = {
      maxTokensPerSession: typeof cb.maxTokensPerSession === 'number' && cb.maxTokensPerSession > 0
        ? Math.round(cb.maxTokensPerSession) : 100_000,
      warnAt: typeof cb.warnAt === 'number' && cb.warnAt > 0
        ? Math.round(cb.warnAt) : 80_000,
      throttleAt: typeof cb.throttleAt === 'number' && cb.throttleAt > 0
        ? Math.round(cb.throttleAt) : 95_000,
    };
  }

  // Validate glob patterns — exclude unsafe regex patterns
  const include = _validatePatterns(raw.include, defaults.include);
  const exclude = _validatePatterns(raw.exclude, defaults.exclude);

  return {
    version,
    languages,
    include,
    exclude,
    maxFileSize,
    extractDocstrings,
    trackCallSites,
    enableEmbeddings,
    embeddingModel,
    embeddingDim,
    useVecIndex,
    semanticEngine,
    turboquantMemDocs,
    turboquantBits,
    turbovecMemDocs,
    turbovecBits,
    typesenseDashboard,
    qdrantDashboard,
    minLogLevel,
    frameworkHints,
    fuzzyResolutionThreshold,
    enableArchitecture: finalEnableArchitecture,
    cavemanMode,
    shellCompressionLevel,
    syncWarningThreshold,
    enableMemory,
    memorySearchAlpha,
    memoryKeepRaw,
    memoryMaxObservations,
    memorySessionTimeout,
    memoryContextLimit,
    memoryContextThreshold,
    memoryExcludePatterns,
    enableWatchmen: enableWatchmen && enableMemory,
    watchmenThreshold,
    watchmenSynthesisMode,
    watchmenLocalModel,
    enableWiki,
    wikiSynthesisMode,
    wikiLocalModel,
    wikiSources,
    wikiAutoResolveConflicts,
    wikiLintFrequency,
    wikiContextLimit,
    wikiContextThreshold,
    enableDocs,
    docsInclude,
    docsExclude,
    docsLinkCode,
    docsContextLimit,
    docsContextThreshold,
    docsMaxFileSize,
    docsSummarization,
    enableData,
    dataInclude,
    dataExclude,
    dataLinkCode,
    dataContextLimit,
    dataMaxFileSize,
    dataMaxRows,
    dataQueryLimit,
    dataMaxResponseTokens,
    enableVisualPDF: enableVisualPDF && enableData,
    pixelragPort,
    enableSecurity,
    securityDatabases,
    securityAutoEnrich,
    securityEnrichMaxAgeDays,
    securityLicensePolicy,
    enablePatterns,
    patternLibraryPath,
    patternSeverityThreshold,
    enableCodeHealth,
    enableAdvancedAnalysis,
    enableAgentUtils,
    enableGeneralCompression,
    enableShellExec: shellCompressionLevel !== 'off',
    ...(architectureLayers !== undefined ? { architectureLayers } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  };
}

function _validateArchitectureLayers(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string') continue;
    if (!Array.isArray(val)) continue;
    const patterns = val.filter((p): p is string => typeof p === 'string' && isSafeRegex(p));
    if (patterns.length > 0) result[key] = patterns;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function _validatePatterns(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const valid: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    if (!isSafeRegex(p)) {
      logWarn(`Unsafe regex pattern skipped: ${p}`);
      continue;
    }
    valid.push(p);
  }
  return valid;
}

// ── Migration helpers ─────────────────────────────────────────────────────────

/**
 * Upgrades shallow exclude patterns (e.g. "node_modules/**") to recursive ones
 * (e.g. "** /node_modules/**") so nested directories are excluded at any depth.
 */
const SHALLOW_TO_RECURSIVE: Record<string, string> = {
  'node_modules/**': '**/node_modules/**',
  'dist/**': '**/dist/**',
  'build/**': '**/build/**',
  '.git/**': '**/.git/**',
  '.kirograph/**': '**/.kirograph/**',
};

function migrateExcludePatterns(patterns: string[]): string[] {
  return patterns.map(p => SHALLOW_TO_RECURSIVE[p] ?? p);
}

// ── Load / Save ───────────────────────────────────────────────────────────────

export async function loadConfig(projectRoot: string): Promise<KiroGraphConfig> {
  const dir = path.join(projectRoot, KIROGRAPH_DIR);
  const cfgPath = path.join(dir, CONFIG_FILE);

  if (!fs.existsSync(cfgPath)) {
    // Create default config file
    const defaults = createDefaultConfig(projectRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    await _writeAtomic(cfgPath, defaults);
    return defaults;
  }

  let raw: unknown;
  try {
    const text = await fs.promises.readFile(cfgPath, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    logError('Config parse error', { path: cfgPath, error: err instanceof Error ? err.message : String(err) });
    return createDefaultConfig(projectRoot);
  }

  const config = validateConfig(raw);

  // Migrate v1 → v2: upgrade shallow exclude patterns to recursive
  if (config.version < 2) {
    config.version = 2;
    config.exclude = migrateExcludePatterns(config.exclude);
    await fs.promises.mkdir(dir, { recursive: true });
    await _writeAtomic(cfgPath, config);
  }

  return config;
}

export async function saveConfig(projectRoot: string, config: KiroGraphConfig): Promise<void> {
  const dir = path.join(projectRoot, KIROGRAPH_DIR);
  const cfgPath = path.join(dir, CONFIG_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  await _writeAtomic(cfgPath, config);
}

async function _writeAtomic(cfgPath: string, config: KiroGraphConfig): Promise<void> {
  const tmp = cfgPath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fs.promises.rename(tmp, cfgPath);
}

// ── Update helpers ────────────────────────────────────────────────────────────

export async function updateConfig(
  projectRoot: string,
  patch: Partial<KiroGraphConfig>
): Promise<KiroGraphConfig> {
  const current = await loadConfig(projectRoot);
  const updated = validateConfig({ ...current, ...patch });
  await saveConfig(projectRoot, updated);
  return updated;
}

export async function addIncludePatterns(projectRoot: string, patterns: string[]): Promise<void> {
  const config = await loadConfig(projectRoot);
  const existing = new Set(config.include);
  const toAdd = patterns.filter(p => isSafeRegex(p) && !existing.has(p));
  if (toAdd.length === 0) return;
  await saveConfig(projectRoot, { ...config, include: [...config.include, ...toAdd] });
}

export async function addExcludePatterns(projectRoot: string, patterns: string[]): Promise<void> {
  const config = await loadConfig(projectRoot);
  const existing = new Set(config.exclude);
  const toAdd = patterns.filter(p => isSafeRegex(p) && !existing.has(p));
  if (toAdd.length === 0) return;
  await saveConfig(projectRoot, { ...config, exclude: [...config.exclude, ...toAdd] });
}

// ── File inclusion check ──────────────────────────────────────────────────────

export function shouldIncludeFile(config: KiroGraphConfig, relPath: string): boolean {
  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (picomatch(pattern)(relPath)) return false;
  }
  // If include patterns are specified, file must match at least one
  if (config.include.length > 0) {
    return config.include.some(pattern => picomatch(pattern)(relPath));
  }
  return true;
}
