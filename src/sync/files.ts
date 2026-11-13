/**
 * The files of the workspace, listed once per sync and shared by the phases that look for their own
 * kind of file (documentation, data files, manifests).
 *
 * Each of those phases walked the whole tree by itself, and pruned only the folders its own exclude
 * patterns named at the top (`node_modules/**`, `.git/**`). In a workspace that holds several
 * repositories that meant walking the `.git` folder of every repository, and any nested
 * `node_modules` or `.terraform`, on every sync, and indexing (and embedding) the READMEs found there.
 *
 * The list here is what git lists in each repository (tracked files, and untracked files that are
 * not ignored: `git ls-files --cached --others --exclude-standard`), plus, in a workspace that is
 * not itself inside a repository, the files outside the repositories, found by a walk that does not
 * enter them and prunes the excluded folders. Without git it is a pruned walk of everything.
 *
 * Paths are relative to the workspace, with forward slashes. A file deleted but still in the git
 * index is listed; callers that need the file check it exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import picomatch from 'picomatch';
import type { KiroGraphConfig } from '../config';
import { findGitRoots } from './index';

/** Folders never listed, whatever the configuration says. */
const ALWAYS_SKIP = new Set(['.git', '.kirograph', 'node_modules']);

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, '/');
}

/** True when the folder `rel` (relative to the workspace) is excluded by the main exclude patterns. */
function excludedDirMatcher(config: KiroGraphConfig): (rel: string, name: string) => boolean {
  const matchers = config.exclude.map(p => {
    try { return picomatch(p, { dot: true }); } catch { return () => false; }
  });
  // Each folder is asked about once per listing, not once per file under it
  const seen = new Map<string, boolean>();
  return (rel, name) => {
    let excluded = seen.get(rel);
    if (excluded === undefined) {
      excluded = ALWAYS_SKIP.has(name) || matchers.some(m => {
        try { return m(rel + '/') || m(rel + '/x'); } catch { return false; }
      });
      seen.set(rel, excluded);
    }
    return excluded;
  };
}

/**
 * Walks `dir`, calling `onFile` with each file's workspace-relative path. Does not enter excluded
 * folders, nor, with `stopAtRepos`, folders that are repositories of their own.
 */
function walk(
  root: string, dir: string, isExcluded: (rel: string, name: string) => boolean,
  stopAtRepos: boolean, onFile: (rel: string) => void,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = toRel(root, full);
    if (entry.isDirectory()) {
      if (isExcluded(rel, entry.name)) continue;
      if (stopAtRepos && fs.existsSync(path.join(full, '.git'))) continue;
      walk(root, full, isExcluded, stopAtRepos, onFile);
    } else if (entry.isFile()) {
      onFile(rel);
    }
  }
}

/** The files git lists in `gitRoot`, workspace-relative, or null when git cannot list them. */
function gitListed(root: string, gitRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: gitRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean).map(rel => toRel(root, path.join(gitRoot, rel)));
  } catch {
    return null;
  }
}

/** True when `dir` is inside a git work tree (a repository, or a folder in one). */
function insideRepository(dir: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * The files outside the repositories of a workspace that is not itself in one, workspace-relative.
 * Empty when the workspace is a repository or a folder inside one. The sync fingerprint covers these
 * (see state.ts), since git reports nothing about them.
 */
export function listFilesOutsideRepos(root: string, config: KiroGraphConfig): string[] {
  const roots = findGitRoots(root);
  if (roots.length === 1 && path.resolve(roots[0]) === path.resolve(root)) {
    // The workspace is a repository, a folder inside one, or has no repository at all
    if (fs.existsSync(path.join(root, '.git')) || insideRepository(root)) return [];
  }
  const files: string[] = [];
  walk(root, root, excludedDirMatcher(config), true, rel => files.push(rel));
  return files;
}

function listUncached(root: string, config: KiroGraphConfig): string[] {
  const isExcluded = excludedDirMatcher(config);
  const files: string[] = [];
  const roots = findGitRoots(root);
  const workspaceIsRepo = roots.length === 1 && path.resolve(roots[0]) === path.resolve(root);

  for (const gitRoot of roots) {
    const listed = gitListed(root, gitRoot);
    if (listed) {
      // What git lists, less the folders KiroGraph excludes (a tracked node_modules, say)
      for (const rel of listed) {
        const parts = rel.split('/');
        let skip = false;
        for (let i = 1; i < parts.length && !skip; i++) {
          skip = isExcluded(parts.slice(0, i).join('/'), parts[i - 1]);
        }
        if (!skip) files.push(rel);
      }
    } else {
      // No git, or git failed: walk it
      walk(root, gitRoot, isExcluded, false, rel => files.push(rel));
    }
  }
  if (!workspaceIsRepo) files.push(...listFilesOutsideRepos(root, config));
  return files;
}

/**
 * The list of the sync running in this async context. Per context, not global: a second sync that
 * waits for the first (in the MCP server) must list the files as they are when it runs.
 */
const store = new AsyncLocalStorage<{ lists: Map<string, string[]> }>();

/**
 * Every file of the workspace, workspace-relative. Inside `withWorkspaceFileCache` it is computed
 * once and shared; outside it, every call lists again.
 */
export function listWorkspaceFiles(root: string, config: KiroGraphConfig): string[] {
  const resolved = path.resolve(root);
  const scope = store.getStore();
  const key = `${resolved}\0${config.exclude.join('\0')}`;
  const cached = scope?.lists.get(key);
  if (cached) return cached;
  const files = listUncached(resolved, config);
  scope?.lists.set(key, files);
  return files;
}

/**
 * Runs `fn` with the file list shared between the calls it makes. Used around a sync, whose phases
 * would each list the files again; the list is dropped when `fn` ends, so the next sync sees the
 * files as they are then.
 */
export function withWorkspaceFileCache<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ lists: new Map() }, fn);
}

/** Matchers for a list of patterns, compiled once. */
export function matcherFor(patterns: string[]): (rel: string) => boolean {
  const ms = patterns.map(p => {
    try { return picomatch(p); } catch { return () => false; }
  });
  return rel => ms.some(m => m(rel));
}
