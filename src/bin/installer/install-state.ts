/**
 * KiroGraph Installer — what the last install wrote (`.kirograph/install-state.json`).
 *
 * Running the installer again must not undo the user's changes to what it wrote. Comparing what
 * is on disk with what the last install wrote tells the two cases apart: a tool or hook that was
 * written and is gone now was removed by the user, and stays removed; one that was never written
 * (new in this version, or of a feature turned on now) is added.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface InstallState {
  /** Tools last written to `autoApprove` of the kirograph entry in `.kiro/settings/mcp.json`. */
  autoApprove?: string[];
  /** Tools last written to `allowedTools` of `.kiro/agents/kirograph.json`. */
  allowedTools?: string[];
  /** Ids of the hooks last written to `.kiro/hooks/`. */
  hooks?: string[];
}

function statePath(kiroDir: string): string {
  return path.join(path.dirname(kiroDir), '.kirograph', 'install-state.json');
}

export function readInstallState(kiroDir: string): InstallState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(kiroDir), 'utf8')) as InstallState;
  } catch {
    return null;
  }
}

export function updateInstallState(kiroDir: string, patch: InstallState): void {
  const next = { ...(readInstallState(kiroDir) ?? {}), ...patch };
  try {
    fs.mkdirSync(path.dirname(statePath(kiroDir)), { recursive: true });
    fs.writeFileSync(statePath(kiroDir), JSON.stringify(next, null, 2) + '\n');
  } catch { /* the next install then treats missing entries as removed by the user, the safe side */ }
}

/**
 * The tool list to write, keeping the user's changes to the existing one:
 * - a tool the last install wrote and the user removed stays removed;
 * - without a record of the last install, a known tool missing from an existing list is taken as
 *   removed by the user (a list that approves less is the safe side);
 * - entries the user added that the installer does not manage are kept, after the computed ones.
 *
 * `computed` is what this install would write on a fresh project; `known` every name the
 * installer manages (all KiroGraph tools, enabled or not).
 */
export function mergeToolList(
  computed: string[],
  existing: string[] | undefined,
  previous: string[] | undefined,
  known: string[],
): string[] {
  if (!Array.isArray(existing)) return [...computed];
  const has = new Set(existing);
  const knownSet = new Set(known);
  let result: string[];
  if (previous) {
    const removedByUser = new Set(previous.filter(t => !has.has(t)));
    result = computed.filter(t => !removedByUser.has(t));
  } else {
    result = computed.filter(t => has.has(t));
  }
  const written = new Set(result);
  for (const t of existing) {
    if (!knownSet.has(t) && !written.has(t)) { result.push(t); written.add(t); }
  }
  return result;
}
