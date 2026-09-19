/**
 * NPM Version Extraction Plugin for KiroGraph-Sec
 *
 * Extends the existing architecture npm parser to extract version constraints,
 * resolved versions (from lock files), and dependency scopes for security analysis.
 *
 * Reuses `npmParser` from `src/architecture/manifest/npm.ts` for discovery and
 * basic parsing, then layers on version/scope extraction.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/** Scope fields in package.json mapped to their ParsedDependency scope */
const SCOPE_FIELDS: Array<{ field: string; scope: ParsedDependency['scope'] }> = [
  { field: 'dependencies', scope: 'production' },
  { field: 'devDependencies', scope: 'development' },
  { field: 'optionalDependencies', scope: 'optional' },
];

/**
 * Resolved version map: package name → resolved version string.
 * Built from package-lock.json or yarn.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse an npm package.json manifest and extract dependency declarations
 * with version constraints, scopes, and resolved versions from lock files.
 *
 * @param manifestPath - Absolute path to the package.json file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseNpmManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read and parse the package.json
  let pkg: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logWarn(`[sec:npm] Invalid package.json structure at ${relativeManifest}`);
      return [];
    }
    pkg = parsed as Record<string, unknown>;
  } catch (err) {
    logWarn(`[sec:npm] Failed to read/parse ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from lock file
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract the package-level license
  const license = extractNpmLicense(pkg);

  // Extract dependencies from each scope field
  const dependencies: ParsedDependency[] = [];
  const warnings: Array<{ name: string; reason: string }> = [];

  for (const { field, scope } of SCOPE_FIELDS) {
    const depsObj = pkg[field];
    if (depsObj === undefined || depsObj === null) continue;

    if (typeof depsObj !== 'object' || Array.isArray(depsObj)) {
      logWarn(`[sec:npm] Invalid "${field}" field in ${relativeManifest} — expected object, got ${typeof depsObj}`);
      continue;
    }

    const entries = Object.entries(depsObj as Record<string, unknown>);
    for (const [name, constraint] of entries) {
      // Validate the dependency entry
      if (!isValidDependencyName(name)) {
        logWarn(`[sec:npm] Invalid dependency name "${name}" in ${relativeManifest} (${field}) — skipping`);
        warnings.push({ name, reason: 'invalid name' });
        continue;
      }

      if (typeof constraint !== 'string' || constraint.trim() === '') {
        logWarn(`[sec:npm] Invalid version constraint for "${name}" in ${relativeManifest} (${field}) — skipping`);
        warnings.push({ name, reason: 'invalid constraint' });
        continue;
      }

      const resolvedVersion = resolvedVersions.get(name);

      dependencies.push({
        name,
        declaredConstraint: constraint,
        resolvedVersion,
        scope,
        ecosystem: 'npm',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Also handle peerDependencies — default to production scope
  const peerDeps = pkg.peerDependencies;
  if (peerDeps && typeof peerDeps === 'object' && !Array.isArray(peerDeps)) {
    const peerEntries = Object.entries(peerDeps as Record<string, unknown>);
    for (const [name, constraint] of peerEntries) {
      if (!isValidDependencyName(name)) {
        logWarn(`[sec:npm] Invalid peer dependency name "${name}" in ${relativeManifest} — skipping`);
        warnings.push({ name, reason: 'invalid name' });
        continue;
      }

      if (typeof constraint !== 'string' || constraint.trim() === '') {
        logWarn(`[sec:npm] Invalid version constraint for peer dependency "${name}" in ${relativeManifest} — skipping`);
        warnings.push({ name, reason: 'invalid constraint' });
        continue;
      }

      // Only add if not already declared in another scope
      const alreadyDeclared = dependencies.some(d => d.name === name);
      if (!alreadyDeclared) {
        const resolvedVersion = resolvedVersions.get(name);
        dependencies.push({
          name,
          declaredConstraint: constraint,
          resolvedVersion,
          scope: 'production',
          ecosystem: 'npm',
          sourceManifest: relativeManifest,
          ...(license !== undefined ? { license } : {}),
        });
      }
    }
  }

  // Transitive dependencies (present only in the lock file, never declared
  // directly in package.json) would otherwise never become a Dependency_Node,
  // so they'd silently skip vulnerability scanning entirely. Add them here.
  const directNames = new Set(dependencies.map(d => d.name));
  const lockRelativePath = relativeManifest.replace(/package\.json$/, 'package-lock.json');
  dependencies.push(...extractTransitiveNpmDependencies(manifestDir, lockRelativePath, directNames));

  return dependencies;
}

/**
 * Extract every package listed in package-lock.json's "packages" map (lockfile
 * v2/v3) that isn't already a direct dependency. These are transitive-only
 * packages — e.g. a sub-dependency three levels deep — that `npm audit` reports
 * on but that package.json never mentions.
 *
 * Only the npm "packages" (v2/v3) format is supported here; lockfileVersion 1,
 * pnpm-lock.yaml, and yarn.lock still resolve versions for direct dependencies
 * only (tracked as a follow-up).
 */
function extractTransitiveNpmDependencies(
  manifestDir: string,
  lockRelativePath: string,
  directNames: Set<string>,
): ParsedDependency[] {
  const lockPath = path.join(manifestDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return [];

  let lockData: unknown;
  try {
    lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    logWarn(`[sec:npm] Failed to parse ${lockRelativePath} for transitive dependencies: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (typeof lockData !== 'object' || lockData === null) return [];
  const packages = (lockData as Record<string, unknown>).packages;
  if (typeof packages !== 'object' || packages === null) return [];

  const transitive: ParsedDependency[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    if (key === '') continue; // skip the root project entry
    if (typeof value !== 'object' || value === null) continue;
    const pkg = value as Record<string, unknown>;

    const name = key.replace(/^.*node_modules\//, '');
    if (!name || directNames.has(name) || seen.has(name)) continue;

    const version = pkg.version;
    if (typeof version !== 'string') continue;

    seen.add(name);
    transitive.push({
      name,
      // No real semver range exists at the project level for a transitive
      // package — the resolved version is the only constraint we have.
      declaredConstraint: version,
      resolvedVersion: version,
      scope: pkg.dev === true ? 'development' : 'production',
      ecosystem: 'npm',
      sourceManifest: lockRelativePath,
    });
  }

  return transitive;
}

/**
 * Attempt to load resolved versions from package-lock.json, pnpm-lock.yaml,
 * or yarn.lock in the given directory. Returns an empty map if none is available.
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  // Try package-lock.json first (preferred — npm)
  const lockPath = path.join(manifestDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lockContent = fs.readFileSync(lockPath, 'utf8');
      const lockData = JSON.parse(lockContent);
      extractFromPackageLock(lockData, map);
      return map;
    } catch (err) {
      logWarn(`[sec:npm] Failed to parse package-lock.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Try pnpm-lock.yaml (pnpm)
  const pnpmLockPath = path.join(manifestDir, 'pnpm-lock.yaml');
  if (fs.existsSync(pnpmLockPath)) {
    try {
      const pnpmContent = fs.readFileSync(pnpmLockPath, 'utf8');
      extractFromPnpmLock(pnpmContent, map);
      return map;
    } catch (err) {
      logWarn(`[sec:npm] Failed to parse pnpm-lock.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fall back to yarn.lock
  const yarnLockPath = path.join(manifestDir, 'yarn.lock');
  if (fs.existsSync(yarnLockPath)) {
    try {
      const yarnContent = fs.readFileSync(yarnLockPath, 'utf8');
      extractFromYarnLock(yarnContent, map);
      return map;
    } catch (err) {
      logWarn(`[sec:npm] Failed to parse yarn.lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return map;
}

/**
 * Extract resolved versions from pnpm-lock.yaml (v5, v6, v9 formats).
 *
 * v5/v6: packages section with keys like "/express/4.18.2" or "/express@4.18.2"
 * v9:    snapshots section with keys like "express@4.18.2" and
 *        packages section with "express@4.18.2: {version: ...}" (optional)
 */
function extractFromPnpmLock(content: string, map: ResolvedVersionMap): void {
  // v9 format: package entries under `packages:` or `snapshots:`
  // Key format: "name@version" or "@scope/name@version"
  // We extract name@version pairs from both sections.

  // Match lines like:  /express/4.18.2:  or  /express@4.18.2:  or  express@4.18.2:
  for (const m of content.matchAll(/^[\s]*\/?(@?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)[@/]([0-9][a-zA-Z0-9._-]*)(?:\(.*?\))?:/gm)) {
    const name = m[1].replace(/^\//, ''); // strip leading slash for scoped packages
    const version = m[2];
    if (name && version && !map.has(name)) {
      map.set(name, version);
    }
  }
}

/**
 * Extract resolved versions from package-lock.json (supports v2 and v3 format).
 */
function extractFromPackageLock(lockData: unknown, map: ResolvedVersionMap): void {
  if (typeof lockData !== 'object' || lockData === null) return;
  const lock = lockData as Record<string, unknown>;

  // lockfileVersion 2/3: uses "packages" field with "" as root
  const packages = lock.packages;
  if (typeof packages === 'object' && packages !== null) {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (key === '') continue; // skip root
      if (typeof value !== 'object' || value === null) continue;
      const pkg = value as Record<string, unknown>;
      const version = pkg.version;
      if (typeof version !== 'string') continue;

      // Key format: "node_modules/<name>" or "node_modules/@scope/name"
      const name = key.replace(/^.*node_modules\//, '');
      if (name && !map.has(name)) {
        map.set(name, version);
      }
    }
    return;
  }

  // lockfileVersion 1: uses "dependencies" field
  const dependencies = lock.dependencies;
  if (typeof dependencies === 'object' && dependencies !== null) {
    extractFromLockV1Dependencies(dependencies as Record<string, unknown>, map);
  }
}

/**
 * Recursively extract versions from lockfileVersion 1 dependencies.
 */
function extractFromLockV1Dependencies(
  deps: Record<string, unknown>,
  map: ResolvedVersionMap,
): void {
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== 'object' || value === null) continue;
    const dep = value as Record<string, unknown>;
    const version = dep.version;
    if (typeof version === 'string' && !map.has(name)) {
      map.set(name, version);
    }
    // Recurse into nested dependencies
    const nested = dep.dependencies;
    if (typeof nested === 'object' && nested !== null) {
      extractFromLockV1Dependencies(nested as Record<string, unknown>, map);
    }
  }
}

/**
 * Extract resolved versions from yarn.lock (v1 format).
 * yarn.lock uses a custom format, not JSON.
 */
function extractFromYarnLock(content: string, map: ResolvedVersionMap): void {
  const lines = content.split('\n');
  let currentPackageName: string | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') {
      currentPackageName = null;
      continue;
    }

    // Package header line: "package-name@version-range:" or "@scope/name@range:"
    // Can also be: "package-name@range1, package-name@range2:"
    if (!line.startsWith(' ') && line.endsWith(':')) {
      const header = line.slice(0, -1); // remove trailing ':'
      // Extract package name from the first entry (before @version)
      const name = extractPackageNameFromYarnHeader(header);
      currentPackageName = name;
      continue;
    }

    // Version line: "  version "x.y.z""
    if (currentPackageName && line.trim().startsWith('version ')) {
      const versionMatch = line.match(/version\s+"([^"]+)"/);
      if (versionMatch && !map.has(currentPackageName)) {
        map.set(currentPackageName, versionMatch[1]);
      }
      currentPackageName = null;
    }
  }
}

/**
 * Extract the package name from a yarn.lock header line.
 * Handles formats like:
 *   - "express@^4.17.1"
 *   - "@types/node@^18.0.0"
 *   - "express@^4.17.1, express@^4.18.0"
 *   - '"express@^4.17.1"'
 */
function extractPackageNameFromYarnHeader(header: string): string | null {
  // Take the first entry if comma-separated
  const firstEntry = header.split(',')[0].trim();
  // Remove surrounding quotes if present
  const cleaned = firstEntry.replace(/^["']|["']$/g, '');

  // Find the last @ that separates name from version
  // For scoped packages (@scope/name@version), we need the last @
  const lastAtIndex = cleaned.lastIndexOf('@');
  if (lastAtIndex <= 0) return null; // no @ or starts with @ (scoped without version)

  // For scoped packages, check if the first char is @
  if (cleaned.startsWith('@')) {
    // @scope/name@version — find the @ after the scope
    const afterScope = cleaned.indexOf('/', 1);
    if (afterScope === -1) return null;
    const atAfterName = cleaned.indexOf('@', afterScope);
    if (atAfterName === -1) return cleaned; // no version part
    return cleaned.slice(0, atAfterName);
  }

  return cleaned.slice(0, lastAtIndex);
}

/**
 * Extract the license field from a parsed package.json object.
 * Handles both string format (`"MIT"`) and object format (`{"type":"MIT"}`).
 */
function extractNpmLicense(pkg: Record<string, unknown>): string | undefined {
  const raw = pkg['license'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim();
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const licObj = raw as Record<string, unknown>;
    if (typeof licObj['type'] === 'string' && licObj['type'].trim() !== '') {
      return licObj['type'].trim();
    }
  }
  // Handle legacy "licenses" array
  const licenses = pkg['licenses'];
  if (Array.isArray(licenses) && licenses.length > 0) {
    const first = licenses[0];
    if (typeof first === 'object' && first !== null) {
      const lic = first as Record<string, unknown>;
      if (typeof lic['type'] === 'string' && lic['type'].trim() !== '') {
        return lic['type'].trim();
      }
    }
    if (typeof first === 'string' && first.trim() !== '') {
      return first.trim();
    }
  }
  return undefined;
}

/**
 * Validate that a dependency name follows npm naming conventions.
 * Must be non-empty, not start with a dot or underscore (unless scoped),
 * and contain only valid characters.
 */
function isValidDependencyName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 214) return false;

  // Scoped packages: @scope/name
  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length !== 2) return false;
    if (!parts[0] || !parts[1]) return false;
    return true;
  }

  // Unscoped: must not start with . or _
  if (name.startsWith('.') || name.startsWith('_')) return false;

  return true;
}
