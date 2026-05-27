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
  semanticEngine: 'cosine' | 'sqlite-vec' | 'orama' | 'pglite' | 'lancedb' | 'qdrant' | 'typesense';
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
  'useVecIndex', 'semanticEngine', 'typesenseDashboard', 'qdrantDashboard',
  'minLogLevel', 'frameworkHints', 'fuzzyResolutionThreshold',
  'enableArchitecture', 'architectureLayers', 'cavemanMode', 'shellCompressionLevel', 'syncWarningThreshold',
  'enableMemory', 'memorySearchAlpha', 'memoryKeepRaw', 'memoryMaxObservations',
  'memorySessionTimeout', 'memoryContextLimit', 'memoryContextThreshold', 'memoryExcludePatterns',
  'enableDocs', 'docsInclude', 'docsExclude', 'docsLinkCode',
  'docsContextLimit', 'docsContextThreshold', 'docsMaxFileSize', 'docsSummarization',
  'enableData', 'dataInclude', 'dataExclude', 'dataLinkCode',
  'dataContextLimit', 'dataMaxFileSize', 'dataMaxRows', 'dataQueryLimit', 'dataMaxResponseTokens',
  'contextBudget',
  // Legacy aliases (still accepted, mapped during validation)
  'enableCompression', 'compressionLevel',
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
    extractDocstrings: true,
    trackCallSites: true,
    enableEmbeddings: false,
    embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
    embeddingDim: 768,
    useVecIndex: false,
    semanticEngine: 'cosine',
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
    enableDocs: false,
    docsInclude: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.asciidoc', '**/*.rdoc', '**/*.org', '**/*.cheatmd', 'docs/**/*.txt', 'docs/**/*.html'],
    docsExclude: ['node_modules/**', '**/CHANGELOG*', '**/LICENSE*', '**/CHANGES*', 'dist/**', 'build/**', 'coverage/**', '.git/**', '**/generated/**', '**/auto-generated/**', '**/vendor/**', '_build/**'],
    docsLinkCode: true,
    docsContextLimit: 0,
    docsContextThreshold: 0.3,
    docsMaxFileSize: 1_048_576,
    docsSummarization: 'first-sentence',
    enableData: false,
    dataInclude: ['**/*.csv', '**/*.tsv', '**/*.jsonl', '**/*.ndjson', '**/*.xlsx', '**/*.xls', '**/*.parquet', 'data/**/*.json'],
    dataExclude: ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/tsconfig.json', '**/jsconfig.json', 'coverage/**', '**/generated/**'],
    dataLinkCode: true,
    dataContextLimit: 0,
    dataMaxFileSize: 52_428_800,
    dataMaxRows: 1_000_000,
    dataQueryLimit: 500,
    dataMaxResponseTokens: 8000,
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
  const SEMANTIC_ENGINES = new Set(['cosine', 'sqlite-vec', 'orama', 'pglite', 'lancedb', 'qdrant', 'typesense']);
  // useVecIndex is a legacy alias: if set and no explicit semanticEngine, map it
  const semanticEngine = typeof raw.semanticEngine === 'string' && SEMANTIC_ENGINES.has(raw.semanticEngine)
    ? (raw.semanticEngine as KiroGraphConfig['semanticEngine'])
    : useVecIndex ? 'sqlite-vec' : defaults.semanticEngine;
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
    typesenseDashboard,
    qdrantDashboard,
    minLogLevel,
    frameworkHints,
    fuzzyResolutionThreshold,
    enableArchitecture,
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
