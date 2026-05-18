/**
 * Language detection and tree-sitter grammar mapping
 */

import type { Language } from '../types';

export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.svelte': 'svelte',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.liquid': 'liquid',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.scala': 'scala',
  '.sc': 'scala',
  '.sbt': 'scala',
  '.lua': 'lua',
  '.zig': 'zig',
  '.zon': 'zig',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.elm': 'elm',
  '.sol': 'solidity',
  '.vue': 'vue',
  '.m': 'objc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
};

export const GRAMMAR_MAP: Record<Language, string> = {
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
  csharp: 'tree-sitter-c-sharp',
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
  hcl: 'tree-sitter-hcl',
  // Pascal and Liquid require custom WASM not bundled in tree-sitter-wasms
  pascal: '',
  liquid: '',
  unknown: '',
};

export function detectLanguage(filePath: string): Language {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'unknown';
}

export function isSupportedLanguage(lang: Language): boolean {
  // All known languages are "supported" for indexing purposes.
  // Pascal and Liquid don't have a grammar WASM, so they'll be indexed
  // with empty symbol lists (file tracked but no AST extraction).
  return lang !== 'unknown';
}
