/**
 * KiroGraph PatternRunner — lazy-loads @ast-grep/napi and executes pattern rules.
 */

import { PatternRule, PatternMatch, SEVERITY_ORDER } from './types';
import { logWarn } from '../errors';

// Languages the @ast-grep/napi binary bundles natively (its built-in Lang enum).
// napi.Lang is an empty object at runtime (values are type-only), so we enumerate
// these explicitly rather than reading from the export.
const NAPI_BUILTIN_LANGUAGES = new Set([
  'html', 'javascript', 'jsx', 'typescript', 'tsx', 'css',
]);

// Module-level cache: undefined = not yet attempted, null = missing, module = loaded
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _napi: any | null | undefined = undefined;
let _napiWarnLogged = false;
// Runtime-detected set of languages the installed @ast-grep/napi actually supports,
// derived from its Lang enum on first load. Null until napi has been loaded.
let _napiRuntimeLangs: Set<string> | null = null;

// Optional language packages that extend napi beyond its built-in JS/TS/HTML/CSS set.
// registerDynamicLanguage() loads a tree-sitter grammar .so for each entry.
// Keys must match the language strings used in pattern rule files and the files table.
const DYNAMIC_LANG_PACKAGES: Record<string, string> = {
  go:     '@ast-grep/lang-go',
  python: '@ast-grep/lang-python',
  java:   '@ast-grep/lang-java',
  rust:   '@ast-grep/lang-rust',
  c:      '@ast-grep/lang-c',
  cpp:    '@ast-grep/lang-cpp',
  cs:     '@ast-grep/lang-csharp',
  kotlin: '@ast-grep/lang-kotlin',
  swift:  '@ast-grep/lang-swift',
  ruby:   '@ast-grep/lang-ruby',
  php:    '@ast-grep/lang-php',
  bash:   '@ast-grep/lang-bash',
  scala:  '@ast-grep/lang-scala',
  dart:   '@ast-grep/lang-dart',
  lua:    '@ast-grep/lang-lua',
  elixir: '@ast-grep/lang-elixir',
  haskell:'@ast-grep/lang-haskell',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNapi(): Promise<any | null> {
  if (_napi !== undefined) return _napi;
  try {
    // Verify it can be resolved synchronously before async import
    require.resolve('@ast-grep/napi');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _napi = require('@ast-grep/napi');

    // Register any installed dynamic language grammars. Must happen before the
    // first parse() call and exactly once per process.
    const registrations: Record<string, unknown> = {};
    for (const [langName, pkgName] of Object.entries(DYNAMIC_LANG_PACKAGES)) {
      try {
        require.resolve(pkgName);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        registrations[langName] = require(pkgName);
      } catch {
        // Package not installed — skip silently; language simply won't be supported.
      }
    }
    if (Object.keys(registrations).length > 0 && typeof _napi.registerDynamicLanguage === 'function') {
      _napi.registerDynamicLanguage(registrations);
    }

    // Build the runtime language set: built-in grammars + successfully registered
    // dynamic ones. napi.Lang is {} at runtime (type-only enum), so we use the
    // explicit NAPI_BUILTIN_LANGUAGES constant as the base.
    _napiRuntimeLangs = new Set([
      ...NAPI_BUILTIN_LANGUAGES,
      ...Object.keys(registrations),
    ]);
    return _napi;
  } catch {
    _napi = null;
    if (!_napiWarnLogged) {
      logWarn('PatternRunner: @ast-grep/napi is not installed. Pattern matching is disabled. Run: npm install @ast-grep/napi');
      _napiWarnLogged = true;
    }
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderFix(fixTemplate: string, node: any): string | undefined {
  if (!fixTemplate) return undefined;
  // Replace $VAR metavariables with matched text
  return fixTemplate.replace(/\$([A-Z_]+)/g, (_, varName) => {
    try {
      return node.getMatch(varName)?.text() ?? `$${varName}`;
    } catch {
      return `$${varName}`;
    }
  });
}

export class PatternRunner {
  /**
   * Synchronously check whether @ast-grep/napi is available.
   */
  isAvailable(): boolean {
    try {
      require.resolve('@ast-grep/napi');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if the language is supported by @ast-grep/napi.
   * Unsupported languages must be skipped — calling parse() on them throws a
   * native C++ exception that bypasses JS try/catch and corrupts internal mutexes.
   */
  isSupportedLanguage(language: string): boolean {
    const lang = language.toLowerCase();
    // After napi loads, _napiRuntimeLangs reflects exactly what this binary
    // supports (built-ins + registered dynamic langs). Before that, we conservatively
    // allow only the known built-in set so we don't accidentally call parse() on an
    // unsupported language before registration has happened.
    if (_napiRuntimeLangs !== null) return _napiRuntimeLangs.has(lang);
    return NAPI_BUILTIN_LANGUAGES.has(lang);
  }

  /**
   * Lazy async loader — returns the napi module or null if missing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getNapi(): Promise<any | null> {
    return getNapi();
  }

  /**
   * Run a single library rule against a file's content.
   * Returns an empty array and logs a warning on per-file errors.
   */
  async runRule(rule: PatternRule, fileContent: string, language: string): Promise<PatternMatch[]> {
    if (!this.isSupportedLanguage(language)) return [];
    const napi = await getNapi();
    if (!napi) return [];
    // Re-check after napi loads — _napiRuntimeLangs is now populated and may
    // exclude languages the static list includes (e.g. Go in a JS-only build).
    if (!this.isSupportedLanguage(language)) return [];

    try {
      const { parse } = napi;
      const root = parse(language as any, fileContent);
      const nodes = root.root().findAll({ rule: rule.rule as any });
      const lines = fileContent.split('\n');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return nodes.map((node: any) => {
        const range = node.range();
        const line = range.start.line + 1; // 1-based
        const col = range.start.column;    // 0-based
        const matchText = node.text().slice(0, 500);
        const context = _buildContext(lines, range.start.line);
        const fixSuggestion = rule.fix ? renderFix(rule.fix, node) : undefined;

        return {
          patternId: rule.id,
          filePath: '',
          line,
          col,
          matchText,
          context,
          severity: rule.severity,
          owaspCategory: rule.owaspCategory,
          language,
          ...(fixSuggestion !== undefined ? { fixSuggestion } : {}),
        };
      });
    } catch (err) {
      logWarn(`PatternRunner: error running rule "${rule.id}" on file (language: ${language}): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Run an inline pattern expression (not from library) against file content.
   * Returns an empty array and logs a warning on per-file errors.
   */
  async runInline(pattern: string, language: string, fileContent: string): Promise<PatternMatch[]> {
    if (!this.isSupportedLanguage(language)) return [];
    const napi = await getNapi();
    if (!napi) return [];
    if (!this.isSupportedLanguage(language)) return [];

    try {
      const { parse } = napi;
      const root = parse(language as any, fileContent);
      const nodes = root.root().findAll(pattern);
      const lines = fileContent.split('\n');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return nodes.map((node: any) => {
        const range = node.range();
        const line = range.start.line + 1;
        const col = range.start.column;
        const matchText = node.text().slice(0, 500);
        const context = _buildContext(lines, range.start.line);

        return {
          patternId: '',
          filePath: '',
          line,
          col,
          matchText,
          context,
          severity: 'low' as const,
          owaspCategory: '',
          language,
        };
      });
    } catch (err) {
      logWarn(`PatternRunner: error running inline pattern on file (language: ${language}): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Run all rules against a file's content, filtered by severity threshold.
   */
  async runAllRules(
    rules: PatternRule[],
    fileContent: string,
    language: string,
    threshold: PatternRule['severity'],
  ): Promise<PatternMatch[]> {
    const napi = await getNapi();
    if (!napi) return [];

    const thresholdOrder = SEVERITY_ORDER[threshold];
    const applicableRules = rules.filter(r => {
      const langs = Array.isArray(r.language) ? r.language : [r.language];
      return langs.includes(language) && SEVERITY_ORDER[r.severity] >= thresholdOrder;
    });

    const results: PatternMatch[] = [];
    for (const rule of applicableRules) {
      const matches = await this.runRule(rule, fileContent, language);
      results.push(...matches);
    }
    return results;
  }

  /**
   * Apply the rule's fix template to all matches in the file content.
   * Returns the transformed source string, or null if no fix was applied.
   * Uses a range-based text substitution approach since commitEdits may not
   * be available in all versions of @ast-grep/napi.
   */
  async applyFix(filePath: string, fileContent: string, language: string, rule: PatternRule): Promise<string | null> {
    const napi = await this.getNapi();
    if (!napi || !rule.fix) return null;
    if (!this.isSupportedLanguage(language)) return null;
    try {
      const { parse } = napi;
      const root = parse(language as any, fileContent);
      const nodes = root.root().findAll({ rule: rule.rule as any });
      if (nodes.length === 0) return null;

      // Try the native commitEdits API first
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const node of nodes as any[]) {
          const fixText = renderFix(rule.fix, node);
          if (fixText) node.replace(fixText);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const edited: string | null | undefined = (root.root() as any).commitEdits?.();
        if (typeof edited === 'string') return edited;
      } catch {
        // commitEdits not available — fall through to text substitution
      }

      // Fallback: apply replacements using byte offsets, processing from end to start
      // so earlier replacements don't shift the offsets of later ones.
      interface Edit { start: number; end: number; replacement: string }
      const edits: Edit[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const node of nodes as any[]) {
        const fixText = renderFix(rule.fix, node);
        if (fixText === undefined) continue;
        const range = node.range();
        // Convert line/col to byte offset
        const lines = fileContent.split('\n');
        let startOffset = 0;
        for (let i = 0; i < range.start.line; i++) {
          startOffset += (lines[i]?.length ?? 0) + 1; // +1 for \n
        }
        startOffset += range.start.column;

        let endOffset = 0;
        for (let i = 0; i < range.end.line; i++) {
          endOffset += (lines[i]?.length ?? 0) + 1;
        }
        endOffset += range.end.column;

        edits.push({ start: startOffset, end: endOffset, replacement: fixText });
      }

      if (edits.length === 0) return null;

      // Sort descending by start offset so we can splice without re-indexing
      edits.sort((a, b) => b.start - a.start);

      let result = fileContent;
      for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
      }

      return result !== fileContent ? result : null;
    } catch (err) {
      logWarn(`PatternRunner.applyFix: error applying fix for rule "${rule.id}" on "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

function _buildContext(lines: string[], zeroBasedLine: number): string {
  const contextLines: string[] = [];
  if (zeroBasedLine > 0) contextLines.push(lines[zeroBasedLine - 1] ?? '');
  contextLines.push(lines[zeroBasedLine] ?? '');
  if (zeroBasedLine + 1 < lines.length) contextLines.push(lines[zeroBasedLine + 1] ?? '');
  return contextLines.join('\n');
}
