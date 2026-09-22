/**
 * Composer Version Extraction Plugin for KiroGraph-Sec
 *
 * Parses composer.json manifests to extract PHP package declarations with
 * version constraints, scopes, and resolved versions from composer.lock.
 *
 * Handles:
 * - `require` section → 'production' scope
 * - `require-dev` section → 'development' scope
 * - Skips `php`, `ext-*`, and `platform` entries (not installable packages)
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Resolved version map: package name → resolved version string.
 * Built from composer.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a composer.json manifest and extract package declarations with
 * version constraints, scopes, and resolved versions from composer.lock.
 *
 * @param manifestPath - Absolute path to the composer.json file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseComposerManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the composer.json content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:composer] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Parse JSON
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    logWarn(`[sec:composer] Failed to parse JSON in ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from composer.lock
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract the project-level license
  const license = extractComposerLicense(manifest);

  const dependencies: ParsedDependency[] = [];

  // Process `require` (production) and `require-dev` (development) sections
  const sections: Array<{ key: string; scope: ParsedDependency['scope'] }> = [
    { key: 'require', scope: 'production' },
    { key: 'require-dev', scope: 'development' },
  ];

  for (const { key, scope } of sections) {
    const section = manifest[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;

    for (const [pkgName, versionConstraint] of Object.entries(section as Record<string, unknown>)) {
      // Skip PHP runtime and extensions
      if (shouldSkipEntry(pkgName)) continue;

      if (typeof versionConstraint !== 'string') {
        logWarn(`[sec:composer] Non-string version for "${pkgName}" in ${relativeManifest} — skipping`);
        continue;
      }

      if (!isValidPackageName(pkgName)) {
        logWarn(`[sec:composer] Invalid package name "${pkgName}" in ${relativeManifest} — skipping`);
        continue;
      }

      const resolvedVersion = resolvedVersions.get(pkgName.toLowerCase());
      dependencies.push({
        name: pkgName,
        declaredConstraint: versionConstraint,
        resolvedVersion,
        scope,
        ecosystem: 'composer',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Transitive-only packages (present in composer.lock but never declared in
  // composer.json) would otherwise never become a Dependency_Node and would
  // silently skip vulnerability scanning. resolvedVersions already has every
  // package composer.lock resolved, direct or transitive (lower-cased —
  // production/dev origin isn't tracked separately, default to production).
  const directNames = new Set(dependencies.map(d => d.name.toLowerCase()));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'composer',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * Determine whether a composer.json key should be skipped.
 * Skips `php`, `ext-*`, and `platform` entries.
 */
function shouldSkipEntry(name: string): boolean {
  if (name === 'php') return true;
  if (name.startsWith('ext-')) return true;
  if (name === 'platform') return true;
  return false;
}

/**
 * Validate that a Composer package name follows the `vendor/package` convention.
 * Also accepts bare names for legacy packages, but rejects obviously invalid entries.
 */
function isValidPackageName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 255) return false;
  // Composer names must be vendor/package (lowercase, hyphens, digits allowed)
  return /^[a-z0-9]([a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*)$/.test(name);
}

/**
 * Attempt to load resolved versions from composer.lock in the given directory.
 * Returns an empty map if composer.lock is not available.
 *
 * composer.lock format (JSON):
 * ```json
 * {
 *   "packages": [{ "name": "vendor/package", "version": "1.2.3" }],
 *   "packages-dev": [{ "name": "vendor/dev-package", "version": "v2.0.0" }]
 * }
 * ```
 * Version strings may be prefixed with `v` — these are stripped.
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'composer.lock');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    extractFromComposerLock(lockContent, map);
  } catch (err) {
    logWarn(`[sec:composer] Failed to parse composer.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from composer.lock content.
 *
 * Reads both `packages` (production) and `packages-dev` arrays.
 * Normalises version strings by stripping a leading `v`.
 */
function extractFromComposerLock(content: string, map: ResolvedVersionMap): void {
  let lockData: Record<string, unknown>;
  try {
    lockData = JSON.parse(content) as Record<string, unknown>;
  } catch {
    logWarn('[sec:composer] composer.lock is not valid JSON — resolved versions unavailable');
    return;
  }

  const arrays = [lockData['packages'], lockData['packages-dev']];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const pkg = entry as Record<string, unknown>;
      const name = typeof pkg['name'] === 'string' ? pkg['name'].toLowerCase() : null;
      const version = typeof pkg['version'] === 'string' ? pkg['version'] : null;
      if (name && version) {
        // Strip leading `v` from version strings (e.g. "v1.2.3" → "1.2.3")
        const normalised = version.startsWith('v') ? version.slice(1) : version;
        if (!map.has(name)) {
          map.set(name, normalised);
        }
      }
    }
  }
}

/**
 * Extract the license field from a parsed composer.json manifest.
 * The "license" field can be a string or an array of strings (SPDX).
 */
function extractComposerLicense(manifest: Record<string, unknown>): string | undefined {
  const raw = manifest['license'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    return (raw as string[]).join(' OR ');
  }
  return undefined;
}
