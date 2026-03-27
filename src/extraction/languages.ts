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
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.svelte': 'svelte',
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
  unknown: '',
};

export function detectLanguage(filePath: string): Language {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'unknown';
}

export function isSupportedLanguage(lang: Language): boolean {
  return lang !== 'unknown' && GRAMMAR_MAP[lang] !== '';
}
