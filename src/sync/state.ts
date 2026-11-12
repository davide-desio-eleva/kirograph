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
 * the configuration and the KiroGraph version, so a change of either runs a real sync.
 *
 * It is stored after a sync that finished without errors, and compared at the start of the next.
 * A project outside git has no fingerprint (null): its syncs always run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import type { KiroGraphConfig } from '../config';
import { findGitRoots } from './index';

const STATE_FILE = 'sync-state.json';
const STATE_FORMAT = 1;
const DAY_MS = 86_400_000;
/**
 * How long a stored state is trusted. Git does not report files it ignores, and KiroGraph indexes
 * some of them (it has its own exclude patterns, not .gitignore), so a change to such a file is
 * invisible to the fingerprint. After this long a real sync runs and looks at every file.
 */
const MAX_AGE_MS = 10 * 60_000;

interface SyncState {
  format: number;
  fingerprint: string;
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

/** The configuration that changes what a sync does. Detected frameworks are an output, not an input. */
function configKey(config: KiroGraphConfig): string {
  const { frameworkHints: _ignored, ...rest } = config as KiroGraphConfig & { frameworkHints?: unknown };
  return stableStringify(rest);
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
export function workspaceFingerprint(projectRoot: string, config: KiroGraphConfig): string | null {
  const hash = crypto.createHash('sha1');
  hash.update(`format ${STATE_FORMAT}|version ${packageVersion()}|config ${configKey(config)}`);

  for (const gitRoot of findGitRoots(projectRoot)) {
    if (!fs.existsSync(path.join(gitRoot, '.git'))) return null;
    let status: string;
    try {
      // -uall lists the files of an untracked directory one by one. Without it a new directory
      // shows as one entry, and a file edited inside it would leave the status unchanged.
      status = git(gitRoot, ['status', '--porcelain', '--no-renames', '-uall', '-z']);
    } catch {
      return null;
    }
    let head = 'no-head';
    try { head = git(gitRoot, ['rev-parse', 'HEAD']).trim(); } catch { /* an empty repository has no HEAD */ }
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
    const state: SyncState = { format: STATE_FORMAT, fingerprint, at: Date.now() };
    const target = statePath(projectRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target); // atomic: a reader never sees half a file
  } catch { /* the state is an optimisation: a sync that cannot store it still worked */ }
}

/** Forgets the stored state, so the next sync runs in full. */
export function clearSyncState(projectRoot: string): void {
  try { fs.unlinkSync(statePath(projectRoot)); } catch { /* not there */ }
}

/**
 * True when `fingerprint` is the one stored by the last sync, so a sync would find nothing.
 *
 * The stored state is trusted for `MAX_AGE_MS`. With security enabled that limit can only be
 * shorter than the vulnerability data's own (`securityEnrichMaxAgeDays`, 7 by default), so data
 * that ages while no file changes is refreshed by the real sync that follows.
 */
export function isUpToDate(projectRoot: string, config: KiroGraphConfig, fingerprint: string | null): boolean {
  if (!fingerprint) return false;
  const state = readState(projectRoot);
  if (!state || state.fingerprint !== fingerprint) return false;
  const maxAge = config.enableSecurity
    ? Math.min(MAX_AGE_MS, (config.securityEnrichMaxAgeDays ?? 7) * DAY_MS)
    : MAX_AGE_MS;
  return Date.now() - state.at <= maxAge;
}
