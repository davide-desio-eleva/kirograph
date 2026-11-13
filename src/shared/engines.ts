/**
 * Optional packages (embedding engines, data parsers, pattern matching) and where they live.
 *
 * The installer used to run `npm install <package>` in whatever folder it was started from, that
 * is the user's project: it created a package.json, a lock file and a node_modules of hundreds of
 * megabytes there, and the security analysis then listed the packages as dependencies of the
 * project. They are installed into a folder of their own now, `~/.kirograph/engines`, and loaded
 * from there when they are not found the ordinary way. A package an older installer put in the
 * project is still found.
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

/** Where optional packages are installed. KIROGRAPH_ENGINES_DIR overrides it. */
export function enginesDir(): string {
  return process.env.KIROGRAPH_ENGINES_DIR || path.join(os.homedir(), '.kirograph', 'engines');
}

function isMissing(err: unknown, name: string): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'MODULE_NOT_FOUND' && String(e.message ?? '').includes(name.split('/').slice(0, 2).join('/'));
}

/** Folders to look in, in order, after the ordinary resolution from KiroGraph's own location. */
function searchBases(): string[] {
  return [path.join(enginesDir(), 'package.json'), path.join(process.cwd(), 'package.json')];
}

/** `require` for an optional package: from KiroGraph's install, the engines folder, then the project. */
export function requireEngine(name: string): any {
  let first: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(name);
  } catch (err) {
    if (!isMissing(err, name)) throw err; // found but broken (a native module for another Node): say so
    first = err;
  }
  for (const base of searchBases()) {
    try {
      return createRequire(base)(name);
    } catch (err) {
      if (!isMissing(err, name)) throw err;
    }
  }
  throw first;
}

/** Like `require.resolve` for an optional package. Returns null when it is not installed anywhere. */
export function resolveEngine(name: string): string | null {
  try {
    return require.resolve(name);
  } catch { /* try the others */ }
  for (const base of searchBases()) {
    try { return createRequire(base).resolve(name); } catch { /* next */ }
  }
  return null;
}

/** Installs packages into the engines folder. Returns npm's exit status (null when it did not start). */
export function installEngines(packages: string[]): { status: number | null } {
  const result = spawnSync(
    'npm',
    ['install', '--prefix', enginesDir(), '--no-audit', '--no-fund', ...packages],
    { stdio: 'inherit', shell: true },
  );
  return { status: result.status };
}

/** The command a user can run by hand, for a message. */
export function installCommand(packages: string[]): string {
  return `npm install --prefix "${enginesDir()}" ${packages.join(' ')}`;
}
