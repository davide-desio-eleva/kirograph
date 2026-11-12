/**
 * What the security analysis needs to run again.
 *
 * The analysis costs seconds to minutes (manifests are parsed, vulnerability databases are queried
 * over the network, reachability is computed), and a sync after every agent turn ran all of it
 * even when only a source file had changed. Its inputs are separate:
 *
 *  - the dependency manifests and lock files: what the dependencies are;
 *  - the age of the vulnerability data: new advisories appear while nothing in the project changes,
 *    so it is refreshed after `securityEnrichMaxAgeDays` (7 by default);
 *  - the code graph: where the dependencies are used, and what is reachable.
 *
 * The state of the last complete run is kept in `.kirograph/security-state.json`. Anything missing
 * or unreadable means a full run.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { KiroGraphConfig } from '../config';
import { ManifestParser } from './manifest/parser';

const STATE_FILE = 'security-state.json';
const STATE_FORMAT = 1;
const DAY_MS = 86_400_000;
/** Files next to a manifest that fix the versions it resolves to. */
const LOCK_LIKE = /(lock|\.sum$|\.resolved$)/i;

export interface SecurityState {
  format: number;
  /** Signature of the manifests and lock files. */
  manifests: string;
  /** The configuration that changes what the analysis does. */
  config: string;
  /** When vulnerability data was last fetched, epoch ms. */
  enrichedAt: number;
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, '.kirograph', STATE_FILE);
}

/** Signature of the manifests and the lock files beside them: path, size and modification time. */
export function manifestSignature(projectRoot: string, config: KiroGraphConfig): string {
  const parser = new ManifestParser({} as never, projectRoot, { include: config.include, exclude: config.exclude });
  const files = new Set<string>();
  for (const manifest of parser.getAdapter().discoverManifests()) {
    files.add(manifest);
    const dir = path.dirname(manifest);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (LOCK_LIKE.test(name)) files.add(path.join(dir, name));
      }
    } catch { /* the directory went away: the manifest's own stat will say so */ }
  }
  const hash = crypto.createHash('sha1');
  for (const file of [...files].sort()) {
    try {
      const stat = fs.statSync(file);
      hash.update(`${path.relative(projectRoot, file)}:${stat.size}:${stat.mtimeMs}\n`);
    } catch { /* removed since discovery: left out, which is a different signature */ }
  }
  return hash.digest('hex');
}

export function securityConfigKey(config: KiroGraphConfig): string {
  return JSON.stringify([config.securityDatabases, config.securityAutoEnrich, config.include, config.exclude]);
}

export function readSecurityState(projectRoot: string): SecurityState | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8')) as SecurityState;
    return state.format === STATE_FORMAT && typeof state.manifests === 'string' ? state : null;
  } catch {
    return null;
  }
}

export function writeSecurityState(projectRoot: string, state: Omit<SecurityState, 'format'>): void {
  try {
    const target = statePath(projectRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: STATE_FORMAT, ...state }));
    fs.renameSync(tmp, target);
  } catch { /* an optimisation: the next run is simply a full one */ }
}

export interface SecurityPlan {
  /** Parse manifests, resolve transitive dependencies and query vulnerability databases. */
  manifests: boolean;
  /** Query vulnerability databases again. */
  enrich: boolean;
  /** Link dependencies to code and compute reachability. */
  graph: boolean;
  /** Nothing to do at all. */
  skip: boolean;
  signature: string;
}

/** What an incremental run has to redo, given what changed since the last complete one. */
export function planSecurityRun(
  projectRoot: string,
  config: KiroGraphConfig,
  graphChanged: boolean,
  now = Date.now(),
): SecurityPlan {
  const signature = manifestSignature(projectRoot, config);
  const state = readSecurityState(projectRoot);
  const same = state !== null && state.manifests === signature && state.config === securityConfigKey(config);
  if (!same) return { manifests: true, enrich: true, graph: true, skip: false, signature };

  const maxAge = (config.securityEnrichMaxAgeDays ?? 7) * DAY_MS;
  const stale = now - state.enrichedAt > maxAge;
  return {
    manifests: false,
    enrich: stale,
    graph: graphChanged || stale,
    skip: !graphChanged && !stale,
    signature,
  };
}
