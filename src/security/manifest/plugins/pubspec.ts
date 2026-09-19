/**
 * Dart/Flutter pub Version Extraction Plugin for KiroGraph-Sec
 *
 * Parses pubspec.yaml manifests to extract Dart package declarations with
 * version constraints, scopes, and resolved versions from pubspec.lock.
 *
 * Uses lightweight regex-based YAML parsing — no external YAML library required.
 *
 * Handles:
 * - `dependencies:` section → 'production' scope
 * - `dev_dependencies:` section → 'development' scope
 * - Version formats: `^1.0.0`, `">=1.0.0 <2.0.0"`, `any`
 * - Skips SDK entries (`sdk:`), `flutter:`, path deps, and git deps
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Resolved version map: package name → resolved version string.
 * Built from pubspec.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a pubspec.yaml manifest and extract package declarations with
 * version constraints, scopes, and resolved versions from pubspec.lock.
 *
 * @param manifestPath - Absolute path to the pubspec.yaml file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parsePubspecManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the pubspec.yaml content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:pub] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from pubspec.lock
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract the license field if present
  const license = extractPubspecLicense(content);

  const dependencies: ParsedDependency[] = [];

  // Process `dependencies` (production) and `dev_dependencies` (development)
  const sections: Array<{ key: string; scope: ParsedDependency['scope'] }> = [
    { key: 'dependencies', scope: 'production' },
    { key: 'dev_dependencies', scope: 'development' },
  ];

  for (const { key, scope } of sections) {
    const sectionDeps = extractSectionDependencies(content, key, relativeManifest);
    for (const dep of sectionDeps) {
      const resolvedVersion = resolvedVersions.get(dep.name);
      dependencies.push({
        name: dep.name,
        declaredConstraint: dep.constraint,
        resolvedVersion,
        scope,
        ecosystem: 'pub',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Transitive-only packages (present in pubspec.lock but never declared in
  // pubspec.yaml) would otherwise never become a Dependency_Node and would
  // silently skip vulnerability scanning. resolvedVersions already has every
  // package pubspec.lock resolved, direct or transitive.
  const directNames = new Set(dependencies.map(d => d.name));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'pub',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * A raw dependency entry extracted from a pubspec.yaml section.
 */
interface RawDependency {
  name: string;
  constraint: string;
}

/**
 * Extract dependencies from a specific top-level section of a pubspec.yaml file.
 * Uses indentation-based parsing to determine section boundaries.
 *
 * Section entries take one of three forms:
 * - `  package_name: ^1.0.0`      (inline scalar version)
 * - `  package_name: ">=1.0.0 <2.0.0"` (quoted version)
 * - `  package_name: any`         (any version)
 * - `  package_name:`             (block mapping — path/git/sdk dep)
 *   `    path: ../local`
 *
 * Entries with sub-keys (block mappings) are skipped as non-registry deps.
 */
function extractSectionDependencies(
  content: string,
  sectionKey: string,
  relativeManifest: string,
): RawDependency[] {
  const deps: RawDependency[] = [];
  const lines = content.split('\n');

  // Find the section header line (at column 0, no indent)
  const headerPattern = new RegExp(`^${escapeRegex(sectionKey)}\\s*:\\s*$`);
  let inSection = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Detect section header
    if (!inSection) {
      if (headerPattern.test(trimmed)) {
        inSection = true;
      }
      i++;
      continue;
    }

    // Exit section when we encounter another top-level key (no leading whitespace)
    if (trimmed !== '' && !/^\s/.test(trimmed)) {
      break;
    }

    // Skip blank lines inside section
    if (trimmed === '') {
      i++;
      continue;
    }

    // Match a 2-space-indented package entry: `  package_name: ...`
    const entryMatch = trimmed.match(/^  ([a-zA-Z0-9_][a-zA-Z0-9_.-]*):\s*(.*)$/);
    if (!entryMatch) {
      i++;
      continue;
    }

    const pkgName = entryMatch[1];
    const valueOnSameLine = entryMatch[2].trim();

    // Check if the next line has deeper indentation (block mapping → skip)
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
    const isBlockMapping = nextLine !== '' && /^    \S/.test(nextLine);

    if (isBlockMapping) {
      // Skip — path/git/sdk dependency; advance past the block
      i++;
      while (i < lines.length) {
        const subLine = lines[i];
        if (subLine.trimEnd() === '' || /^    /.test(subLine)) {
          i++;
        } else {
          break;
        }
      }
      continue;
    }

    // Skip SDK and flutter pseudo-packages
    if (shouldSkipEntry(pkgName)) {
      i++;
      continue;
    }

    if (!isValidPackageName(pkgName)) {
      logWarn(`[sec:pub] Invalid package name "${pkgName}" in ${relativeManifest} — skipping`);
      i++;
      continue;
    }

    const constraint = parseConstraintValue(valueOnSameLine);
    deps.push({ name: pkgName, constraint });
    i++;
  }

  return deps;
}

/**
 * Parse a pubspec.yaml dependency version value string.
 *
 * Handles:
 * - `^1.0.0` → `^1.0.0`
 * - `">=1.0.0 <2.0.0"` → `>=1.0.0 <2.0.0` (quotes stripped)
 * - `'>=1.0.0 <2.0.0'` → `>=1.0.0 <2.0.0`
 * - `any` → `*`
 * - empty → `*`
 */
function parseConstraintValue(value: string): string {
  if (!value || value === '' || value.toLowerCase() === 'any') return '*';

  // Strip surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  return value || '*';
}

/**
 * Determine whether a pubspec.yaml dependency key should be skipped.
 */
function shouldSkipEntry(name: string): boolean {
  if (name === 'sdk') return true;
  if (name === 'flutter') return true;
  return false;
}

/**
 * Validate that a pub package name follows Dart naming conventions.
 * Package names must be lowercase, with underscores, not hyphens.
 */
function isValidPackageName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 128) return false;
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name);
}

/**
 * Attempt to load resolved versions from pubspec.lock in the given directory.
 * Returns an empty map if pubspec.lock is not available.
 *
 * pubspec.lock YAML format:
 * ```yaml
 * packages:
 *   http:
 *     dependency: "direct main"
 *     description:
 *       name: http
 *       url: "https://pub.dartlang.org"
 *     version: "0.13.5"
 *   test:
 *     dependency: "direct dev"
 *     version: "1.21.4"
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'pubspec.lock');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    extractFromPubspecLock(lockContent, map);
  } catch (err) {
    logWarn(`[sec:pub] Failed to parse pubspec.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from pubspec.lock content.
 *
 * The lock file is a YAML document. We use regex-based parsing to avoid
 * introducing a YAML library dependency. For each package block under
 * `packages:`, we find its `version:` entry.
 */
function extractFromPubspecLock(content: string, map: ResolvedVersionMap): void {
  const lines = content.split('\n');
  let inPackagesSection = false;
  let currentPackage: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Detect top-level `packages:` section
    if (trimmed === 'packages:') {
      inPackagesSection = true;
      currentPackage = null;
      continue;
    }

    // Exit packages section if we hit another top-level key
    if (inPackagesSection && trimmed !== '' && !/^\s/.test(trimmed)) {
      inPackagesSection = false;
      currentPackage = null;
      continue;
    }

    if (!inPackagesSection) continue;

    // Package name entry: `  package_name:` (2-space indent)
    const pkgNameMatch = trimmed.match(/^  ([a-zA-Z0-9_][a-zA-Z0-9_.-]*):\s*$/);
    if (pkgNameMatch) {
      currentPackage = pkgNameMatch[1];
      continue;
    }

    // Version entry: `    version: "1.2.3"` (4-space indent)
    if (currentPackage) {
      const versionMatch = trimmed.match(/^    version:\s*["']?([^"'\s]+)["']?\s*$/);
      if (versionMatch) {
        if (!map.has(currentPackage)) {
          map.set(currentPackage, versionMatch[1]);
        }
        currentPackage = null;
      }
    }
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the `license:` field from pubspec.yaml content.
 * Handles: `license: MIT` (top-level scalar field)
 */
function extractPubspecLicense(content: string): string | undefined {
  const match = content.match(/^license:\s*(.+)$/m);
  if (match && match[1].trim() !== '') {
    // Strip surrounding quotes if present
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    return value || undefined;
  }
  return undefined;
}
