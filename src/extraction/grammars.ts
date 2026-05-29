/**
 * Grammar Module — lazy WASM grammar loading for tree-sitter.
 * Centralises all grammar management previously inline in extractor.ts.
 * Sequential loading via grammarLoadChain prevents WASM race condition on Node 20+.
 */

import * as path from 'path';
import type { Language } from '../types';

// ── Module-level singletons ───────────────────────────────────────────────────

let parserLib: any = null;
let parserInitPromise: Promise<void> | null = null;
const loadedGrammars = new Map<Language, any>();
let grammarLoadChain = Promise.resolve();

// ── GRAMMAR_FILE_MAP ──────────────────────────────────────────────────────────

/**
 * Maps each Language to its WASM file name (without .wasm extension).
 * Empty string means no WASM is available for that language.
 * Pascal is bundled separately; all others come from tree-sitter-wasms.
 */
export const GRAMMAR_FILE_MAP: Record<Language, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  jsx: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  csharp: 'tree-sitter-c_sharp',
  php: 'tree-sitter-php',
  ruby: 'tree-sitter-ruby',
  swift: 'tree-sitter-swift',
  kotlin: 'tree-sitter-kotlin',
  dart: 'tree-sitter-dart',
  svelte: 'tree-sitter-svelte',
  elixir: 'tree-sitter-elixir',
  scala: 'tree-sitter-scala',
  lua: 'tree-sitter-lua',
  zig: 'tree-sitter-zig',
  bash: 'tree-sitter-bash',
  ocaml: 'tree-sitter-ocaml',
  elm: 'tree-sitter-elm',
  solidity: 'tree-sitter-solidity',
  vue: 'tree-sitter-vue',
  objc: 'tree-sitter-objc',
  yaml: 'tree-sitter-yaml',
  // HCL (Terraform) is bundled in src/extraction/wasm/ (not in tree-sitter-wasms)
  hcl: 'tree-sitter-hcl',
  // CSS is in tree-sitter-wasms; SCSS is bundled in src/extraction/wasm/
  css: 'tree-sitter-css',
  scss: 'tree-sitter-scss',
  html: 'tree-sitter-html',
  // Pascal is bundled in src/extraction/wasm/ (not in tree-sitter-wasms)
  pascal: 'tree-sitter-pascal',
  // No WASM available
  liquid: '',
  // Jupyter notebooks are parsed via the notebook extractor (Python grammar on extracted code cells)
  jupyter: '',
  unknown: '',
};

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
    await TreeSitter.Parser.init();
    parserLib = TreeSitter;
  })();
  return parserInitPromise;
}

// ── resolveWasmPath ───────────────────────────────────────────────────────────

/**
 * Resolves the filesystem path to the WASM file for a given language.
 * Pascal and HCL use bundled wasm files in src/extraction/wasm/.
 * All others are resolved from the tree-sitter-wasms npm package.
 * Returns null if the file cannot be located.
 */
function resolveWasmPath(lang: Language): string | null {
  if (lang === 'pascal') {
    return path.join(__dirname, 'wasm', 'tree-sitter-pascal.wasm');
  }
  if (lang === 'hcl') {
    return path.join(__dirname, 'wasm', 'tree-sitter-hcl.wasm');
  }
  if (lang === 'scss') {
    return path.join(__dirname, 'wasm', 'tree-sitter-scss.wasm');
  }
  const grammarFile = GRAMMAR_FILE_MAP[lang];
  if (!grammarFile) return null;
  try {
    return require.resolve(`tree-sitter-wasms/out/${grammarFile}.wasm`);
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
          const langObj = await parserLib.Language.load(wasmPath);
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

/**
 * Returns the list of languages for which a WASM grammar file is known.
 * Languages with an empty GRAMMAR_FILE_MAP entry are excluded.
 */
export function getSupportedLanguages(): Language[] {
  return (Object.keys(GRAMMAR_FILE_MAP) as Language[]).filter(
    (lang) => GRAMMAR_FILE_MAP[lang] !== ''
  );
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
