/**
 * Grammar Module — lazy WASM grammar loading for tree-sitter.
 * Centralises all grammar management previously inline in extractor.ts.
 * Sequential loading via grammarLoadChain prevents WASM race condition on Node 20+.
 */

import * as path from 'path';
import type { Language } from '../types';
import * as fs from 'fs';
import { shimLibc, zeroMallocInBinary } from './libc-shims';

// ── Module-level singletons ───────────────────────────────────────────────────

let parserLib: any = null;
let parserInitPromise: Promise<void> | null = null;
const loadedGrammars = new Map<Language, any>();
let grammarLoadChain = Promise.resolve();

// ── Grammar files ──────────────────────────────────────────────────────────────

/**
 * Languages parsed with a tree-sitter grammar that is not their own: JSX is JavaScript. Every
 * other grammar is `wasm/tree-sitter-<language>.wasm`, built from the sources pinned in
 * grammars/grammars.json (see scripts/grammars.mjs). A language without a file there (JSON,
 * Liquid, Jupyter, Svelte) is read without a grammar.
 */
const GRAMMAR_ALIAS: Partial<Record<Language, Language>> = { jsx: 'javascript' };

// ── initGrammars ──────────────────────────────────────────────────────────────

/**
 * Initialises the tree-sitter Parser runtime without loading any language grammars.
 * Safe to call multiple times — idempotent.
 */
export async function initGrammars(): Promise<void> {
  if (parserLib) return;
  if (parserInitPromise) return parserInitPromise;
  parserInitPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TreeSitter = require('web-tree-sitter');
    // web-tree-sitter uses the object passed here as its runtime module, which lets shimLibc add the
    // C library functions that the bash and yaml grammars need and the runtime lacks.
    const runtime: any = {};
    await TreeSitter.Parser.init(runtime);
    shimLibc(runtime);
    parserLib = TreeSitter;
  })();
  return parserInitPromise;
}

// ── resolveWasmPath ───────────────────────────────────────────────────────────

/** The WASM grammar of a language, in dist/extraction/wasm/, or null when it has none. */
function resolveWasmPath(lang: Language): string | null {
  const file = path.join(__dirname, 'wasm', `tree-sitter-${GRAMMAR_ALIAS[lang] ?? lang}.wasm`);
  try {
    require('fs').accessSync(file);
    return file;
  } catch {
    return null;
  }
}

// ── loadGrammarsForLanguages ──────────────────────────────────────────────────

/**
 * Loads WASM grammars for the given languages sequentially.
 * Already-loaded grammars are skipped.
 * WASM load failures are swallowed silently — no throw.
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  for (const lang of languages) {
    if (loadedGrammars.has(lang)) continue;

    await new Promise<void>((resolve) => {
      grammarLoadChain = grammarLoadChain.then(async () => {
        if (loadedGrammars.has(lang)) { resolve(); return; }
        const wasmPath = resolveWasmPath(lang);
        if (!wasmPath) { resolve(); return; }
        try {
          await initGrammars();
          const langObj = await parserLib.Language.load(zeroMallocInBinary(fs.readFileSync(wasmPath)));
          loadedGrammars.set(lang, langObj);
        } catch {
          // Silently skip — no WASM or load failure
        }
        resolve();
      });
    });
  }
}

// ── getParser ─────────────────────────────────────────────────────────────────

/**
 * Returns a configured Parser instance for the given language.
 * Loads the grammar on demand if not yet cached.
 * Returns null if no grammar is available (unsupported/unknown language).
 */
export async function getParser(language: Language): Promise<any | null> {
  // Fast path — already loaded
  if (loadedGrammars.has(language)) {
    await initGrammars();
    const parser = new parserLib.Parser();
    parser.setLanguage(loadedGrammars.get(language));
    return parser;
  }

  // No WASM available for this language
  if (!resolveWasmPath(language)) return null;

  // Load on demand
  await loadGrammarsForLanguages([language]);

  if (!loadedGrammars.has(language)) return null;

  await initGrammars();
  const parser = new parserLib.Parser();
  parser.setLanguage(loadedGrammars.get(language));
  return parser;
}

// ── Remaining exports ─────────────────────────────────────────────────────────

/**
 * Returns true when the grammar for the given language is already in the cache.
 */
export function isGrammarLoaded(language: Language): boolean {
  return loadedGrammars.has(language);
}

/**
 * Returns true if a WASM grammar file exists for the given language,
 * regardless of whether it has been loaded yet.
 * Use this to distinguish "language has no grammar" from "grammar failed to load".
 */
export function hasWasmGrammar(language: Language): boolean {
  return resolveWasmPath(language) !== null;
}

/** The languages that have a WASM grammar. */
export function getSupportedLanguages(): Language[] {
  let files: string[];
  try { files = fs.readdirSync(path.join(__dirname, 'wasm')); } catch { return []; }
  const langs = files
    .filter(f => f.startsWith('tree-sitter-') && f.endsWith('.wasm'))
    .map(f => f.slice('tree-sitter-'.length, -'.wasm'.length) as Language);
  for (const [alias, target] of Object.entries(GRAMMAR_ALIAS)) {
    if (langs.includes(target)) langs.push(alias as Language);
  }
  return langs;
}

/**
 * Removes all cached grammars and resets the module to uninitialised state.
 * Primarily for testing.
 */
export function clearParserCache(): void {
  parserLib = null;
  parserInitPromise = null;
  loadedGrammars.clear();
  grammarLoadChain = Promise.resolve();
}

/**
 * Convenience wrapper — loads all known supported language grammars.
 */
export async function loadAllGrammars(): Promise<void> {
  return loadGrammarsForLanguages(getSupportedLanguages());
}
