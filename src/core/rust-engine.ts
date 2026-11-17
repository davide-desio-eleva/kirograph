/**
 * The native engine (config `"engine": "rust"`, package `kirograph-rust`, sources in
 * native/kirograph-rust).
 *
 * It takes over the two phases where an index spends its time: extraction (parse each file and
 * write its symbols) and reference resolution. It writes the same rows the TypeScript engine
 * writes, so everything else reads the graph as usual. Languages it has no grammar for are
 * extracted by the TypeScript engine and handed to it already extracted, so the files are still
 * written in order and the graph is the same as with `"engine": "node"`.
 *
 * When the package is missing or fails to load, the TypeScript engine is used and the reason is
 * reported once (see rustEngineFallback).
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireEngine } from '../shared/engines';
import { logWarn } from '../errors';
import type { KiroGraphConfig } from '../config';

export interface RustIndexEntry {
  /** Absolute path of a file the native engine parses. */
  path?: string;
  language?: string;
  /** An ExtractedFile from the TypeScript extractor, as JSON. */
  extracted?: string;
  /** The file's stat key, taken before it was read (FileRecord.statKey); recorded with the file. */
  statKey?: string;
}

export interface RustIndexOptions {
  projectRoot: string;
  dbPath: string;
  markerPath?: string;
  /** Re-extract files whose content hash is unchanged (index --force). */
  force: boolean;
  enableComplexity: boolean;
  maxFileSize: number;
  /** false (index): a file over maxFileSize is skipped. true (sync): it is recorded without symbols. */
  trackOversize: boolean;
  synchronousOff: boolean;
  /** Report, per written file, whether it is new and how many nodes and edges it replaced. */
  collectStats: boolean;
  /** Return the ids of the nodes that were replaced (their embeddings must go). */
  collectRemovedIds: boolean;
  threads?: number;
}

export interface RustFileWrite {
  path: string;
  isNew: boolean;
  oldNodes: number;
  oldEdges: number;
  nodes: number;
  edges: number;
}

export interface RustIndexResult {
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  unchanged: number;
  /** Paths (relative) of the files found unchanged by their hash, whose stat key should be recorded. */
  unchangedPaths: string[];
  errors: string[];
  files: RustFileWrite[];
  removedNodeIds: string[];
  timings: Record<string, number>;
}

export interface RustResolveResult {
  resolved: number;
  remaining: number;
  errors: string[];
}

export interface RustEngine {
  nativeLanguages(): string[];
  engineVersion(): string;
  indexFiles(options: RustIndexOptions, entries: RustIndexEntry[], onProgress?: (current: number, total: number) => void): Promise<RustIndexResult>;
  resolveReferences(
    options: { dbPath: string; markerPath?: string; fuzzyThreshold?: number; synchronousOff?: boolean },
    onProgress?: (current: number, total: number) => void,
  ): Promise<RustResolveResult>;
  extractFileJson(path: string, projectRoot: string, language: string, enableComplexity: boolean): string | null;
}

let loaded: RustEngine | null | undefined;
let failure: string | null = null;
let warned = false;

/**
 * The engine in effect. KIROGRAPH_ENGINE overrides the configuration for one run (tests and
 * benchmarks run both engines on one project) without being written to config.json.
 */
export function effectiveEngine(config: KiroGraphConfig): 'node' | 'rust' {
  const env = process.env.KIROGRAPH_ENGINE;
  if (env === 'rust' || env === 'node') return env;
  return config.engine === 'rust' ? 'rust' : 'node';
}

/** The native engine, or null when it is not installed or does not load. Loaded once. */
export function loadRustEngine(): RustEngine | null {
  if (loaded !== undefined) return loaded;
  try {
    // A source checkout's own build first (development), then the installed package
    const isEngine = (m: any) => typeof m?.indexFiles === 'function' && typeof m?.resolveReferences === 'function';
    let mod: any = null;
    const checkout = path.join(__dirname, '..', '..', 'native', 'kirograph-rust');
    if (fs.existsSync(path.join(checkout, 'index.js'))) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      try { mod = require(checkout); } catch { mod = null; }
    }
    if (!isEngine(mod)) mod = requireEngine('kirograph-rust');
    if (!isEngine(mod)) {
      throw new Error('kirograph-rust has no native binary for this platform (build it: cd native/kirograph-rust && npm run build)');
    }
    loaded = mod as RustEngine;
  } catch (err) {
    failure = err instanceof Error ? err.message.split('\n')[0] : String(err);
    loaded = null;
  }
  return loaded;
}

/**
 * The native engine when the configuration asks for it and it loads. When it asks for it and it
 * does not load, warns once and returns null: the TypeScript engine does the work.
 */
export function rustEngineFor(config: KiroGraphConfig): RustEngine | null {
  if (effectiveEngine(config) !== 'rust') return null;
  const engine = loadRustEngine();
  if (!engine && !warned) {
    warned = true;
    logWarn(`engine "rust" is not available, using "node": ${failure}`);
  }
  return engine;
}

/** Why `"engine": "rust"` fell back to the TypeScript engine, or null when it did not. */
export function rustEngineFallback(config: KiroGraphConfig): string | null {
  if (effectiveEngine(config) !== 'rust') return null;
  return loadRustEngine() ? null : `engine "rust" unavailable (${failure}), using "node"`;
}

/** Where the native engine finds the database and this process's writer marker (src/db/db-lock.ts). */
export function rustDbPaths(projectRoot: string): { dbPath: string; markerPath: string } {
  const dir = path.join(projectRoot, '.kirograph');
  return { dbPath: path.join(dir, 'kirograph.db'), markerPath: path.join(dir, 'db-writers', String(process.pid)) };
}

/** Test hook: forget the loaded module. */
export function _resetRustEngine(): void {
  loaded = undefined;
  failure = null;
  warned = false;
}
