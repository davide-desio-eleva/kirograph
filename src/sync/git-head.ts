/**
 * The commit each repository of the workspace is at, and what changed since a known one.
 *
 * `git status` reports what differs from HEAD. It does not report what HEAD itself brought: after a
 * `git pull`, a branch switch or a rebase, the files those commits changed are clean. A sync that
 * trusted the status alone missed them whenever the tree also had an uncommitted change (it then
 * looked only at the status), so the HEAD of each repository is recorded at every sync, and the
 * next one adds the files of `git diff <recorded>..<current>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const HEADS_FILE = 'git-heads.json';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** HEAD read from the files, for the ordinary layouts. Null means ask git. */
export function readHeadFromFiles(gitRoot: string): string | null {
  try {
    const gitDir = path.join(gitRoot, '.git');
    if (!fs.statSync(gitDir).isDirectory()) return null; // worktree or submodule: ask git
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head; // detached
    const ref = head.match(/^ref: (.+)$/)?.[1];
    if (!ref) return null;
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find(l => l.endsWith(` ${ref}`));
      return line ? line.split(' ')[0] : null;
    }
  } catch {
    return null;
  }
}

/** The commit `gitRoot` is at, or null (an empty repository, or git failed). */
export function currentHead(gitRoot: string): string | null {
  const head = readHeadFromFiles(gitRoot);
  if (head) return head;
  try {
    return git(gitRoot, ['rev-parse', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Files changed between two commits, as paths relative to `gitRoot` with their status letter
 * (A added, D deleted, M and the others changed). Null when git cannot tell, for instance when the
 * old commit is gone (a force push followed by garbage collection).
 */
export function diffCommits(gitRoot: string, from: string, to: string): Array<{ status: string; rel: string }> | null {
  if (!/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) return null;
  try {
    // --relative: paths relative to gitRoot, and only those under it, when the workspace is a
    // folder inside a repository
    const out = git(gitRoot, ['diff', '--name-status', '--no-renames', '--relative', '-z', from, to]).split('\0');
    const result: Array<{ status: string; rel: string }> = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      if (!out[i]) break;
      result.push({ status: out[i][0], rel: out[i + 1] });
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Where `dir` is inside its repository ("sub/dir/"), or "" at the top. `git status` reports paths
 * from the top of the repository whatever the directory it runs in.
 */
export function repositoryPrefix(dir: string): string {
  if (fs.existsSync(path.join(dir, '.git'))) return '';
  try {
    return git(dir, ['rev-parse', '--show-prefix']).trim();
  } catch {
    return '';
  }
}

/** Key of a repository in the heads file: its path relative to the workspace. */
export function headKey(projectRoot: string, gitRoot: string): string {
  return path.relative(projectRoot, gitRoot).replace(/\\/g, '/') || '.';
}

function headsPath(projectRoot: string): string {
  return path.join(projectRoot, '.kirograph', HEADS_FILE);
}

/** The heads recorded by the last sync, by `headKey`; empty when none were. */
export function readGitHeads(projectRoot: string): Record<string, string> {
  try {
    const heads = JSON.parse(fs.readFileSync(headsPath(projectRoot), 'utf8'));
    return heads && typeof heads === 'object' ? heads : {};
  } catch {
    return {};
  }
}

export function writeGitHeads(projectRoot: string, heads: Record<string, string>): void {
  try {
    const target = headsPath(projectRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(heads));
    fs.renameSync(tmp, target);
  } catch { /* without it the next sync falls back to a full scan */ }
}

export function clearGitHeads(projectRoot: string): void {
  try { fs.unlinkSync(headsPath(projectRoot)); } catch { /* not there */ }
}
