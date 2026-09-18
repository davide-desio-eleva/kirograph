/**
 * Sync Module — file discovery and change detection
 *
 * Extracted from KiroGraph class private methods in src/index.ts.
 * Provides scanDirectory, hashContent, shouldIncludeFile, and getChangedFiles.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import picomatch from 'picomatch';
import type { KiroGraphConfig } from '../config';
import { detectLanguage } from '../extraction/languages';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns picomatch matchers for all exclude patterns plus .kirographignore root file lines.
 */
function buildExcludeMatchers(config: KiroGraphConfig): ((s: string) => boolean)[] {
  const patterns = [...config.exclude];

  return patterns.map(p => {
    try {
      return picomatch(p);
    } catch {
      return () => false;
    }
  });
}

/**
 * Returns a combined picomatch matcher or null if no include patterns.
 */
function buildIncludeMatcher(config: KiroGraphConfig): ((s: string) => boolean) | null {
  if (!config.include || config.include.length === 0) return null;
  const matchers = config.include.map(p => {
    try {
      return picomatch(p);
    } catch {
      return () => false;
    }
  });
  return (s: string) => matchers.some(m => m(s));
}

/**
 * Returns true when the file at absPath exceeds config.maxFileSize.
 *
 * Uses fs.statSync so the size is checked WITHOUT reading the file into memory.
 * This is what prevents multi-MB compiled bundles from reaching the tree-sitter
 * parser, where the WASM runtime aborts the whole process (issue #33).
 * A stat failure is treated as "does not exceed" so the normal read path can
 * handle (and gracefully skip) an unreadable file.
 */
function exceedsMaxFileSize(absPath: string, config: KiroGraphConfig): boolean {
  try {
    return fs.statSync(absPath).size > config.maxFileSize;
  } catch {
    return false;
  }
}

/**
 * Recursive filesystem walk. Checks .kirographignore, guards against symlink cycles,
 * respects AbortSignal, and filters files through shouldIncludeFile.
 */
function scanDirectoryWalk(
  root: string,
  config: KiroGraphConfig,
  signal?: AbortSignal,
  visited: Set<string> = new Set()
): string[] {
  const results: string[] = [];

  const walk = (dir: string) => {
    if (signal?.aborted) return;

    // Guard against symlink cycles
    let realDir: string;
    try { realDir = fs.realpathSync(dir); } catch { return; }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    // Check for .kirographignore in this directory
    const ignoreFile = path.join(dir, '.kirographignore');
    if (fs.existsSync(ignoreFile)) return;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (signal?.aborted) return;

      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (shouldIncludeFile(rel, config) && !exceedsMaxFileSize(full, config)) {
          const lang = detectLanguage(full);
          if (lang !== 'unknown') results.push(full);
        }
      }
    }
  };

  walk(root);
  return results;
}

// ── Git root helpers ──────────────────────────────────────────────────────────

/**
 * Finds all git roots at or under `root` (including root itself).
 * Returns paths sorted shallowest-first so parent roots are processed before children.
 */
function findGitRoots(root: string): string[] {
  const roots: string[] = [];

  const walk = (dir: string) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      roots.push(dir);
      return; // don't recurse into nested git repos
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };

  walk(root);
  return roots.length > 0 ? roots : [root];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true when relPath passes the include/exclude filter from config.
 * Exclude patterns are checked first; include patterns (if any) are checked second.
 */
export function shouldIncludeFile(relPath: string, config: KiroGraphConfig): boolean {
  const excludeMatchers = buildExcludeMatchers(config);
  if (excludeMatchers.some(m => {
    try { return m(relPath) || m(relPath + '/'); } catch { return false; }
  })) return false;

  const includeMatcher = buildIncludeMatcher(config);
  if (includeMatcher && !includeMatcher(relPath)) return false;

  return true;
}

/**
 * SHA-256 hex digest of the given content.
 */
export function hashContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Returns absolute paths of all indexable files under root.
 * Handles monorepos with multiple nested git roots by running git ls-files
 * from each sub-repo root independently, then merging results.
 * Falls back to filesystem walk if no git roots found.
 * Respects AbortSignal.
 */
export async function scanDirectory(
  root: string,
  config: KiroGraphConfig,
  signal?: AbortSignal
): Promise<string[]> {
  if (signal?.aborted) return [];

  const gitRoots = findGitRoots(root);
  const allFiles: string[] = [];

  for (const gitRoot of gitRoots) {
    if (signal?.aborted) return allFiles;
    try {
      const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (signal?.aborted) return allFiles;
      const files = output.split('\n').filter(Boolean)
        .map(rel => path.join(gitRoot, rel))
        .filter(abs => {
          const rel = path.relative(root, abs).replace(/\\/g, '/');
          return shouldIncludeFile(rel, config)
            && detectLanguage(abs) !== 'unknown'
            && !exceedsMaxFileSize(abs, config);
        });
      allFiles.push(...files);
    } catch {
      // git unavailable for this root — fall back to walk
      allFiles.push(...scanDirectoryWalk(gitRoot, config, signal));
    }
  }

  return allFiles;
}

/**
 * Classifies git-changed files into added / modified / removed across all nested git roots.
 * Returns absolute paths. Returns empty arrays if git is unavailable.
 * Excludes paths whose detected language is 'unknown'.
 */
export async function getChangedFiles(
  root: string,
  config: KiroGraphConfig
): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  const gitRoots = findGitRoots(root);

  for (const gitRoot of gitRoots) {
    try {
      const output = execFileSync('git', ['status', '--porcelain', '--no-renames'], {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      for (const line of output.split('\n').filter(Boolean)) {
        const statusCode = line.slice(0, 2);
        const relPath = line.slice(3).trim();
        const absPath = path.join(gitRoot, relPath);
        if (detectLanguage(absPath) === 'unknown') continue;
        if (statusCode === '??') {
          added.push(absPath);
        } else if (statusCode[0] === 'D' || statusCode[1] === 'D') {
          removed.push(absPath);
        } else {
          modified.push(absPath);
        }
      }
    } catch {
      // git unavailable for this root — skip
    }
  }

  return { added, modified, removed };
}
