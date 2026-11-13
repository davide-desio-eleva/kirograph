/**
 * When the architecture analysis has to run again.
 *
 * The analysis rebuilds every `arch_*` table from scratch: it walks the project for manifests,
 * parses them, reads every import between files and writes packages, layers, dependencies and
 * coupling. A sync ran it every time, also when nothing had changed. Its inputs are:
 *
 *  - the code graph (which files exist, which imports which);
 *  - the manifests (which packages there are, where);
 *  - the configuration (include and exclude patterns, the layers).
 *
 * So it can be skipped when the graph did not change, the manifests have the same paths, sizes and
 * modification times, and the configuration is the same as at the last run. The state of that run
 * is in `.kirograph/architecture-state.json`; anything missing or unreadable means a run.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { KiroGraphConfig } from '../config';
import { findManifestPaths } from './manifest/index';

const STATE_FILE = 'architecture-state.json';
const STATE_FORMAT = 1;

function statePath(projectRoot: string): string {
  return path.join(projectRoot, '.kirograph', STATE_FILE);
}

function packageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return String(require('../../package.json').version);
  } catch {
    return 'unknown';
  }
}

/** Signature of what the analysis reads besides the graph: manifests, configuration, version. */
export function architectureSignature(projectRoot: string, config: KiroGraphConfig): string {
  const hash = crypto.createHash('sha1');
  hash.update(JSON.stringify([
    STATE_FORMAT, packageVersion(), config.include, config.exclude, config.architectureLayers ?? null,
  ]));
  for (const file of findManifestPaths(projectRoot, config.exclude).sort()) {
    try {
      const stat = fs.statSync(file);
      hash.update(`\n${path.relative(projectRoot, file)}:${stat.size}:${stat.mtimeMs}`);
    } catch { /* removed since the walk: left out, which is a different signature */ }
  }
  return hash.digest('hex');
}

export function readArchitectureState(projectRoot: string): string | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8'));
    return state?.format === STATE_FORMAT && typeof state.signature === 'string' ? state.signature : null;
  } catch {
    return null;
  }
}

/** Records the signature of a complete run. */
export function writeArchitectureState(projectRoot: string, signature: string): void {
  try {
    const target = statePath(projectRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: STATE_FORMAT, signature, at: Date.now() }));
    fs.renameSync(tmp, target);
  } catch { /* an optimisation: the next sync simply runs the analysis */ }
}

/** Forgets the last run, so the next sync runs the analysis. */
export function clearArchitectureState(projectRoot: string): void {
  try { fs.unlinkSync(statePath(projectRoot)); } catch { /* not there */ }
}
