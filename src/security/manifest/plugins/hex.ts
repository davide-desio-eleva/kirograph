/**
 * Elixir/Hex Version Extraction Plugin for KiroGraph-Sec
 *
 * Parses mix.exs manifests to extract Elixir package declarations with
 * version constraints, scopes, and resolved versions from mix.lock.
 *
 * Handles:
 * - `{:package_name, "~> 1.0"}` — standard version constraint
 * - `{:package_name, ">= 1.0.0"}` — range constraint
 * - `{:package_name, "1.0.0"}` — exact version
 * - `{:package_name, "~> 1.0", only: [:dev, :test]}` → 'development' scope
 * - `{:package_name, "~> 1.0", only: :dev}` → 'development' scope
 * - Skips git and path dependencies
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Resolved version map: package name → resolved version string.
 * Built from mix.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a mix.exs manifest and extract package declarations with
 * version constraints, scopes, and resolved versions from mix.lock.
 *
 * @param manifestPath - Absolute path to the mix.exs file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseHexManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the mix.exs content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:hex] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from mix.lock
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract dependencies from the deps function
  const rawDeps = extractDepsFromMixExs(content, relativeManifest);
  const dependencies: ParsedDependency[] = [];

  for (const dep of rawDeps) {
    const resolvedVersion = resolvedVersions.get(dep.name);
    dependencies.push({
      name: dep.name,
      declaredConstraint: dep.constraint,
      resolvedVersion,
      scope: dep.scope,
      ecosystem: 'hex',
      sourceManifest: relativeManifest,
    });
  }

  // Transitive-only deps (present in mix.lock but never declared in mix.exs)
  // would otherwise never become a Dependency_Node and would silently skip
  // vulnerability scanning. resolvedVersions already has every dep mix.lock
  // resolved, direct or transitive.
  const directNames = new Set(dependencies.map(d => d.name));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'hex',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * A raw dependency entry extracted from mix.exs.
 */
interface RawDependency {
  name: string;
  constraint: string;
  scope: ParsedDependency['scope'];
}

/**
 * Extract dependencies from mix.exs content.
 *
 * Locates the `defp deps do` function and parses each dependency tuple.
 * Also handles `def deps do` (public deps function).
 *
 * Each dep tuple may span multiple lines, so we work with the full
 * content after extracting the deps list body.
 */
function extractDepsFromMixExs(content: string, relativeManifest: string): RawDependency[] {
  const deps: RawDependency[] = [];

  // Find the deps function body — match `defp deps do` or `def deps do`
  // and extract up to the matching `end`
  const depsBody = extractDepsFunctionBody(content, relativeManifest);
  if (!depsBody) {
    logWarn(`[sec:hex] Could not locate deps function in ${relativeManifest}`);
    return [];
  }

  // Match individual dependency tuples: {:name, "version", ...optional...}
  // The tuple may contain nested content, so we match balanced braces roughly
  const tuplePattern = /\{:([a-zA-Z0-9_]+)\s*,([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = tuplePattern.exec(depsBody)) !== null) {
    const name = match[1];
    const tupleBody = match[2];

    // Skip git/path dependencies
    if (isGitOrPathDep(tupleBody)) continue;

    const version = extractVersionFromTuple(tupleBody);
    if (!version) {
      // Might be a non-version dep (e.g. manager: :rebar3) — skip silently
      continue;
    }

    const scope = extractScopeFromTuple(tupleBody);
    deps.push({ name, constraint: version, scope });
  }

  return deps;
}

/**
 * Extract the body of the `deps` function from mix.exs.
 * Returns the content between the `[` and closing `]` of the deps list,
 * or null if the deps function cannot be located.
 */
function extractDepsFunctionBody(content: string, relativeManifest: string): string | null {
  // Match `defp deps do` or `def deps do` followed by content and `end`
  const funcMatch = content.match(/def[p]?\s+deps\s+do([\s\S]*?)^  end/m);
  if (funcMatch) {
    return funcMatch[1];
  }

  // Alternative: `defp deps,` with a list returned directly (single-expression)
  // e.g. `def deps, do: [...]`
  const inlineMatch = content.match(/def[p]?\s+deps,\s*do:\s*\[([\s\S]*?)\]/);
  if (inlineMatch) {
    return inlineMatch[1];
  }

  // Also try matching a `[...]` list inside the function
  const listMatch = content.match(/def[p]?\s+deps\s+do\s*\[([\s\S]*?)\]\s*end/);
  if (listMatch) {
    return listMatch[1];
  }

  logWarn(`[sec:hex] No deps function found in ${relativeManifest} — trying full file scan`);
  // Last resort: scan entire file for dep tuples (less accurate but better than nothing)
  return content;
}

/**
 * Determine if a dependency tuple body represents a git or path dependency.
 * These lack a standard version string and should be skipped.
 */
function isGitOrPathDep(tupleBody: string): boolean {
  return /\bgit:\s*"/.test(tupleBody) || /\bpath:\s*"/.test(tupleBody);
}

/**
 * Extract the version constraint string from a dependency tuple body.
 * The first string literal in the tuple body is taken as the version.
 *
 * Returns null if no version string is found (e.g. pure option tuples).
 */
function extractVersionFromTuple(tupleBody: string): string | null {
  // Match the first quoted string in the tuple body
  const versionMatch = tupleBody.match(/^\s*"([^"]+)"/);
  if (versionMatch) {
    return versionMatch[1].trim();
  }
  return null;
}

/**
 * Extract the scope from a dependency tuple body by inspecting the `only:` option.
 *
 * `only: [:dev, :test]` → 'development'
 * `only: :dev`          → 'development'
 * `only: :test`         → 'development'
 * `only: :prod`         → 'production'
 * No `only:` option     → 'production'
 */
function extractScopeFromTuple(tupleBody: string): ParsedDependency['scope'] {
  const onlyMatch = tupleBody.match(/\bonly\s*:\s*(.+?)(?:,\s*\w+:|$)/s);
  if (!onlyMatch) return 'production';

  const onlyValue = onlyMatch[1].trim();

  // List form: [:dev, :test] or [:test, :dev, ...]
  if (onlyValue.startsWith('[')) {
    const atoms = onlyValue.match(/:(\w+)/g) || [];
    const values = atoms.map((a) => a.slice(1));
    if (values.some((v) => v === 'dev' || v === 'test')) {
      return 'development';
    }
    return 'production';
  }

  // Atom form: :dev or :test or :prod
  const atom = onlyValue.match(/^:(\w+)/);
  if (atom) {
    if (atom[1] === 'dev' || atom[1] === 'test') return 'development';
    return 'production';
  }

  return 'production';
}

/**
 * Attempt to load resolved versions from mix.lock in the given directory.
 * Returns an empty map if mix.lock is not available.
 *
 * mix.lock format:
 * ```elixir
 * %{
 *   "package" => {:hex, :package_name, "1.2.3", "hash", ...},
 *   "another" => {:hex, :another, "2.0.0", ...},
 * }
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'mix.lock');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    extractFromMixLock(lockContent, map);
  } catch (err) {
    logWarn(`[sec:hex] Failed to parse mix.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from mix.lock content.
 *
 * mix.lock lines follow the pattern:
 * `  "package_name" => {:hex, :package_atom, "1.2.3", "checksum", [...]},`
 *
 * We extract the outer quoted key and the third positional element (version string).
 */
function extractFromMixLock(content: string, map: ResolvedVersionMap): void {
  // Match: "name" => {:hex, :name_atom, "version", ...
  const lockEntryPattern = /^\s*"([^"]+)"\s*=>\s*\{:hex\s*,\s*:[a-zA-Z0-9_]+\s*,\s*"([^"]+)"/gm;
  let match: RegExpExecArray | null;

  while ((match = lockEntryPattern.exec(content)) !== null) {
    const name = match[1];
    const version = match[2];
    if (!map.has(name)) {
      map.set(name, version);
    }
  }
}
