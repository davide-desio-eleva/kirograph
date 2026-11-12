/**
 * Has anything changed since the last sync?
 *
 * A sync that finds nothing to do still cost about a second and a half: Node starts, the
 * database opens, every indexed file is hashed. A fingerprint of the workspace answers the same
 * question in a few tens of milliseconds, so a hook that runs a sync after every agent turn (most
 * of which change nothing) does almost no work.
 *
 * The fingerprint covers what git can report cheaply: the HEAD commit, and the status of the
 * working tree. A file that is already modified keeps the same status line when it is edited
 * again, so each reported file also contributes its modification time and size. It also covers
 * the configuration file and the KiroGraph version, so a change of either runs a real sync.
 *
 * It is stored after a sync that finished without errors, and compared at the start of the next.
 * Nothing here needs the index: `quickIsUpToDate` answers from the state file, git and the
 * configuration file alone, so a sync that has nothing to do can be answered before the database
 * is opened or the library loaded.
 * A project outside git has no fingerprint (null): its syncs always run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { findGitRoots } from './index';

const STATE_FILE = 'sync-state.json';
const STATE_FORMAT = 1;
/**
 * How long a stored state is trusted. Git does not report files it ignores, and KiroGraph indexes
 * some of them (it has its own exclude patterns, not .gitignore), so a change to such a file is
 * invisible to the fingerprint. After this long a real sync runs and looks at every file.
 */
const MAX_AGE_MS = 10 * 60_000;

interface SyncState {
  format: number;
  fingerprint: string;
  /** Identity of the database file the state was recorded for: a replaced database invalidates it. */
  db: string | null;
  /** When the sync that stored it ended, epoch ms. */
  at: number;
}

function packageVersion(): string {
  try {
    // dist/sync/state.js and src/sync/state.ts both sit two levels below the package root
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return String(require('../../package.json').version);
  } catch {
    return 'unknown';
  }
}

/** JSON with object keys in a fixed order, so the same value always gives the same string. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The configuration that changes what a sync does, from the file. Detected frameworks are an
 * output of an index (written back to the file), not an input.
 */
function configKey(projectRoot: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, '.kirograph', 'config.json'), 'utf8'));
    if (raw && typeof raw === 'object') delete (raw as Record<string, unknown>).frameworkHints;
    return stableStringify(raw);
  } catch {
    return 'none'; // no file: the defaults apply
  }
}

/** The file the database lives in. Its identity (not its content, which every write changes). */
function dbIdentity(projectRoot: string): string | null {
  try {
    const stat = fs.statSync(path.join(projectRoot, '.kirograph', 'kirograph.db'));
    return `${stat.ino}:${Math.round(stat.birthtimeMs)}`;
  } catch {
    return null;
  }
}

/** HEAD without starting git, for the ordinary layouts. Null means ask git. */
function readHead(gitRoot: string): string | null {
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Fingerprint of the workspace, or null when it cannot be computed cheaply (no git repository,
 * or git failed).
 */
export function workspaceFingerprint(projectRoot: string): string | null {
  const hash = crypto.createHash('sha1');
  hash.update(`format ${STATE_FORMAT}|version ${packageVersion()}|config ${configKey(projectRoot)}`);

  // Only a workspace that is itself a repository. A folder that holds several repositories has
  // files of its own that git does not report (and repositories it does not list as one), and a
  // fingerprint of the nested ones alone would call a change in those files "nothing changed".
  const roots = findGitRoots(projectRoot);
  if (roots.length !== 1 || path.resolve(roots[0]) !== path.resolve(projectRoot)) return null;
  for (const gitRoot of roots) {
    if (!fs.existsSync(path.join(gitRoot, '.git'))) return null;
    let status: string;
    try {
      // -uall lists the files of an untracked directory one by one. Without it a new directory
      // shows as one entry, and a file edited inside it would leave the status unchanged.
      status = git(gitRoot, ['status', '--porcelain', '--no-renames', '-uall', '-z']);
    } catch {
      return null;
    }
    let head = readHead(gitRoot) ?? 'no-head';
    if (head === 'no-head') {
      try { head = git(gitRoot, ['rev-parse', 'HEAD']).trim(); } catch { /* an empty repository has no HEAD */ }
    }
    hash.update(`|root ${gitRoot}|head ${head}`);

    for (const entry of status.split('\0')) {
      if (!entry) continue;
      const rel = entry.slice(3);
      // Our own files: writing the state must not change the state
      if (rel === '.kirograph' || rel.startsWith('.kirograph/')) continue;
      hash.update(`\n${entry}`);
      try {
        const stat = fs.statSync(path.join(gitRoot, rel));
        hash.update(`:${stat.mtimeMs}:${stat.size}`);
      } catch { /* deleted: the status line says so */ }
    }
  }
  return hash.digest('hex');
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, '.kirograph', STATE_FILE);
}

function readState(projectRoot: string): SyncState | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8')) as SyncState;
    return state.format === STATE_FORMAT && typeof state.fingerprint === 'string' ? state : null;
  } catch {
    return null;
  }
}

/** Records that the workspace described by `fingerprint` has been synced. */
export function writeSyncState(projectRoot: string, fingerprint: string): void {
  try {
    const state: SyncState = { format: STATE_FORMAT, fingerprint, db: dbIdentity(projectRoot), at: Date.now() };
    const target = statePath(projectRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target); // atomic: a reader never sees half a file
  } catch { /* the state is an optimisation: a sync that cannot store it still worked */ }
}

/**
 * True when one of the errors of a sync may not happen again on its own (the database was busy, the
 * disk failed). The files of the others failed to parse, and will fail the same way until they
 * change or KiroGraph does, so retrying them on every sync only repeats the failure.
 */
export function hasTransientErrors(errors: string[]): boolean {
  return errors.some(e => /locked|busy|EBUSY|EAGAIN|EMFILE|ENOSPC|EIO|unrecoverable|timed? ?out/i.test(e));
}

const ERRORS_FILE = 'sync-errors.json';
const MAX_ERRORS_KEPT = 2000;

/** Keeps the errors of the last sync, so they can be listed after it (an empty list removes the file). */
export function writeSyncErrors(projectRoot: string, errors: string[]): void {
  const target = path.join(projectRoot, '.kirograph', ERRORS_FILE);
  try {
    if (errors.length === 0) { fs.rmSync(target, { force: true }); return; }
    fs.writeFileSync(target, JSON.stringify({ at: Date.now(), total: errors.length, errors: errors.slice(0, MAX_ERRORS_KEPT) }));
  } catch { /* a convenience */ }
}

export function readSyncErrors(projectRoot: string): { at: number; total: number; errors: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, '.kirograph', ERRORS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Forgets the stored state, so the next sync runs in full. */
export function clearSyncState(projectRoot: string): void {
  try { fs.unlinkSync(statePath(projectRoot)); } catch { /* not there */ }
}

/**
 * True when `fingerprint` is the one stored by the last sync, so a sync would find nothing.
 *
 * The stored state is trusted for `MAX_AGE_MS`, so the phases that run on every real sync (the
 * architecture and security analyses) still run at least that often.
 */
export function isUpToDate(projectRoot: string, fingerprint: string | null): boolean {
  if (!fingerprint) return false;
  const state = readState(projectRoot);
  if (!state || state.fingerprint !== fingerprint) return false;
  if (state.db === null || state.db !== dbIdentity(projectRoot)) return false;
  return Date.now() - state.at <= MAX_AGE_MS;
}

/**
 * What `sync-if-dirty` asks: should a sync run? Yes when the dirty marker is set, or when the
 * workspace is known to have changed. A workspace that cannot be fingerprinted (not a repository
 * of its own) is not known to have changed, so there only the marker decides, as it always did.
 */
export function quickShouldSyncIfDirty(projectRoot: string): boolean {
  try {
    if (fs.existsSync(path.join(projectRoot, '.kirograph', 'dirty'))) return true;
    const fingerprint = workspaceFingerprint(projectRoot);
    if (!fingerprint) return false;
    return !isUpToDate(projectRoot, fingerprint);
  } catch {
    return false;
  }
}

/**
 * True when a sync would find nothing to do, decided without opening the database or loading the
 * library: no dirty marker, and the stored state matches the workspace. False whenever in doubt.
 */
export function quickIsUpToDate(projectRoot: string): boolean {
  try {
    if (fs.existsSync(path.join(projectRoot, '.kirograph', 'dirty'))) return false;
    return isUpToDate(projectRoot, workspaceFingerprint(projectRoot));
  } catch {
    return false;
  }
}
