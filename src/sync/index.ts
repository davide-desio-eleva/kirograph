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
import { currentHead, diffCommits, headKey, repositoryPrefix } from './git-head';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns picomatch matchers for all exclude patterns plus .kirographignore root file lines.
 */
/**
 * Matchers compiled once per configuration object. `shouldIncludeFile` runs for every file of every
 * scan, and compiling each pattern on every call cost more than the matching.
 */
const excludeCache = new WeakMap<KiroGraphConfig, { key: string; matchers: ((s: string) => boolean)[] }>();
const includeCache = new WeakMap<KiroGraphConfig, { key: string; matcher: ((s: string) => boolean) | null }>();

function buildExcludeMatchers(config: KiroGraphConfig): ((s: string) => boolean)[] {
  // Keyed by the patterns too: a caller may change the list of the same object
  const key = config.exclude.join('\0');
  const cached = excludeCache.get(config);
  if (cached && cached.key === key) return cached.matchers;
  const matchers = compileExcludeMatchers(config);
  excludeCache.set(config, { key, matchers });
  return matchers;
}

function compileExcludeMatchers(config: KiroGraphConfig): ((s: string) => boolean)[] {
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
  const key = (config.include ?? []).join('\0');
  const cached = includeCache.get(config);
  if (cached && cached.key === key) return cached.matcher;
  const matcher = compileIncludeMatcher(config);
  includeCache.set(config, { key, matcher });
  return matcher;
}

function compileIncludeMatcher(config: KiroGraphConfig): ((s: string) => boolean) | null {
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
const ROOT_WALK_SKIP = new Set(['node_modules', '.kirograph']);

export function findGitRoots(root: string): string[] {
  const roots: string[] = [];

  const walk = (dir: string) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      roots.push(dir);
      return; // don't recurse into nested git repos
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      // Installed dependencies hold no repository of the project, and can hold most of its files
      if (entry.isDirectory() && !ROOT_WALK_SKIP.has(entry.name)) walk(path.join(dir, entry.name));
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

export interface ChangedFiles {
  added: string[];
  modified: string[];
  removed: string[];
  /** The HEAD of each repository when this ran, by `headKey`: to record after the sync. */
  heads: Record<string, string>;
  /**
   * True when the lists cover the commits made since `knownHeads` too: every repository had a
   * recorded head, and git could diff it. When false, a change may have come with a commit the
   * lists do not show, and only a full scan is sure to find it.
   */
  complete: boolean;
}

/**
 * Classifies changed files into added / modified / removed across all nested git roots: the
 * uncommitted changes (`git status`), and the files changed by commits since `knownHeads`.
 * Returns absolute paths. Excludes paths whose detected language is 'unknown'.
 */
export async function getChangedFiles(
  root: string,
  config: KiroGraphConfig,
  knownHeads: Record<string, string> = {},
): Promise<ChangedFiles> {
  const added = new Set<string>();
  const touched = new Set<string>();
  const heads: Record<string, string> = {};
  let complete = true;

  for (const gitRoot of findGitRoots(root)) {
    try {
      // -uall lists the files of an untracked directory one by one: without it a new directory is
      // one entry that is not a source file, so the files created inside it were never indexed.
      // -z separates entries with NUL and does not quote names with spaces or non-ASCII characters.
      // A workspace inside a repository: only its own files, with the prefix taken off their paths
      const prefix = repositoryPrefix(gitRoot);
      const output = execFileSync('git', ['status', '--porcelain', '--no-renames', '-uall', '-z', ...(prefix ? ['--', '.'] : [])], {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of output.split('\0').filter(Boolean)) {
        let rel = line.slice(3);
        if (prefix) {
          if (!rel.startsWith(prefix)) continue;
          rel = rel.slice(prefix.length);
        }
        const absPath = path.join(gitRoot, rel);
        if (detectLanguage(absPath) === 'unknown') continue;
        touched.add(absPath);
        if (line.startsWith('??')) added.add(absPath);
      }
    } catch {
      // git unavailable for this root: nothing it reports can be trusted
      complete = false;
      continue;
    }

    const key = headKey(root, gitRoot);
    const head = currentHead(gitRoot);
    if (head) heads[key] = head;
    const known = knownHeads[key];
    if (!head || !known) { if (head !== null || known) complete = false; continue; }
    if (known === head) continue;
    const diff = diffCommits(gitRoot, known, head);
    if (!diff) { complete = false; continue; }
    for (const { status, rel } of diff) {
      const absPath = path.join(gitRoot, rel);
      if (detectLanguage(absPath) === 'unknown') continue;
      touched.add(absPath);
      if (status === 'A') added.add(absPath);
    }
  }

  // What a file is now decides: one deleted by a commit and created again is there
  const result: ChangedFiles = { added: [], modified: [], removed: [], heads, complete };
  for (const absPath of touched) {
    if (!fs.existsSync(absPath)) result.removed.push(absPath);
    else if (added.has(absPath)) result.added.push(absPath);
    else result.modified.push(absPath);
  }
  return result;
}
