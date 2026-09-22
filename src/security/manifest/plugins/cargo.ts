/**
 * Cargo Version Extraction Plugin for KiroGraph-Sec
 *
 * Extends the existing architecture cargo parser to extract version constraints,
 * resolved versions (from Cargo.lock), and dependency scopes for security analysis.
 *
 * Reuses `cargoParser` from `src/architecture/manifest/cargo.ts` for discovery and
 * basic parsing, then layers on version/scope extraction.
 *
 * Handles both simple format (`serde = "1.0"`) and table format
 * (`serde = { version = "1.0", features = ["derive"] }`).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Dependency section headers in Cargo.toml mapped to their ParsedDependency scope.
 */
const SECTION_SCOPES: Array<{ section: string; scope: ParsedDependency['scope'] }> = [
  { section: 'dependencies', scope: 'production' },
  { section: 'dev-dependencies', scope: 'development' },
  { section: 'build-dependencies', scope: 'development' },
];

/**
 * Resolved version map: package name → resolved version string.
 * Built from Cargo.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a Cargo.toml manifest and extract dependency declarations
 * with version constraints, scopes, and resolved versions from Cargo.lock.
 *
 * @param manifestPath - Absolute path to the Cargo.toml file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseCargoManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the Cargo.toml content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:cargo] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from Cargo.lock
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract the package-level license from [package] section
  const license = extractCargoLicense(content);

  // Extract dependencies from each section
  const dependencies: ParsedDependency[] = [];

  for (const { section, scope } of SECTION_SCOPES) {
    const sectionDeps = extractSectionDependencies(content, section, relativeManifest);
    for (const dep of sectionDeps) {
      const resolvedVersion = resolvedVersions.get(dep.name);
      dependencies.push({
        name: dep.name,
        declaredConstraint: dep.constraint,
        resolvedVersion,
        scope,
        ecosystem: 'cargo',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Transitive-only crates (present in Cargo.lock but never declared in
  // Cargo.toml) would otherwise never become a Dependency_Node and would
  // silently skip vulnerability scanning. resolvedVersions already has every
  // crate Cargo.lock resolved, direct or transitive — add whichever aren't
  // already covered by a direct dependency. Exclude the workspace's own
  // crate, which Cargo.lock also lists as a [[package]] entry.
  const rootCrateName = extractCargoPackageName(content);
  const directNames = new Set(dependencies.map(d => d.name));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name) || name === rootCrateName) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'cargo',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * Extract the crate's own name from the [package] section of Cargo.toml, so
 * it can be excluded when adding transitive dependencies from Cargo.lock
 * (which also lists the workspace's own crate as a [[package]] entry).
 */
function extractCargoPackageName(content: string): string | undefined {
  const packageSectionMatch = /^\[package\]\s*$/m.exec(content);
  if (!packageSectionMatch) return undefined;

  const startIdx = packageSectionMatch.index + packageSectionMatch[0].length;
  const remaining = content.slice(startIdx);
  const nextSection = remaining.match(/^\[/m);
  const sectionContent = nextSection ? remaining.slice(0, nextSection.index) : remaining;

  const nameMatch = sectionContent.match(/^name\s*=\s*"([^"]+)"/m);
  return nameMatch ? nameMatch[1].trim() : undefined;
}

/**
 * A raw dependency entry extracted from a TOML section.
 */
interface RawDependency {
  name: string;
  constraint: string;
}

/**
 * Extract dependencies from a specific section of a Cargo.toml file.
 * Handles both simple (`name = "version"`) and table (`name = { version = "..." }`) formats.
 * Also handles `[<section>.<name>]` table headers for individual dependency configuration.
 */
function extractSectionDependencies(
  content: string,
  section: string,
  relativeManifest: string,
): RawDependency[] {
  const deps: RawDependency[] = [];

  // Pattern 1: Inline section [dependencies] / [dev-dependencies] / [build-dependencies]
  // Match the section header and capture everything until the next section header
  const sectionRegex = new RegExp(`^\\[${escapeRegex(section)}\\]\\s*$`, 'm');
  const sectionMatch = sectionRegex.exec(content);

  if (sectionMatch) {
    const startIdx = sectionMatch.index + sectionMatch[0].length;
    // Find the next section header (line starting with [)
    const remaining = content.slice(startIdx);
    const nextSectionMatch = remaining.match(/^\[/m);
    const sectionContent = nextSectionMatch
      ? remaining.slice(0, nextSectionMatch.index)
      : remaining;

    const lines = sectionContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const dep = parseDependencyLine(trimmed, relativeManifest, section);
      if (dep) {
        deps.push(dep);
      }
    }
  }

  // Pattern 2: Table-style individual dependency sections
  // e.g., [dependencies.serde] or [dev-dependencies.tokio]
  const tableRegex = new RegExp(`^\\[${escapeRegex(section)}\\.([^\\]]+)\\]\\s*$`, 'gm');
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(content)) !== null) {
    const depName = tableMatch[1].trim();
    const startIdx = tableMatch.index + tableMatch[0].length;
    const remaining = content.slice(startIdx);
    const nextSectionMatch = remaining.match(/^\[/m);
    const tableContent = nextSectionMatch
      ? remaining.slice(0, nextSectionMatch.index)
      : remaining;

    const version = extractVersionFromTable(tableContent);
    if (version) {
      deps.push({ name: depName, constraint: version });
    } else {
      // If no version specified, it might use path/git — use "*" as constraint
      deps.push({ name: depName, constraint: '*' });
    }
  }

  return deps;
}

/**
 * Parse a single dependency line from a Cargo.toml section.
 *
 * Handles:
 * - Simple string: `serde = "1.0"`
 * - Inline table: `serde = { version = "1.0", features = ["derive"] }`
 * - Path/git dependencies without version: `my-lib = { path = "../my-lib" }`
 */
function parseDependencyLine(
  line: string,
  relativeManifest: string,
  section: string,
): RawDependency | null {
  // Match: name = "version" or name = '...'
  const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"$/);
  if (simpleMatch) {
    const name = simpleMatch[1];
    const constraint = simpleMatch[2];
    if (!isValidCrateName(name)) {
      logWarn(`[sec:cargo] Invalid crate name "${name}" in ${relativeManifest} [${section}] — skipping`);
      return null;
    }
    if (constraint.trim() === '') {
      logWarn(`[sec:cargo] Empty version constraint for "${name}" in ${relativeManifest} [${section}] — skipping`);
      return null;
    }
    return { name, constraint };
  }

  // Match: name = { version = "...", ... }
  const tableMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{(.*)\}\s*$/);
  if (tableMatch) {
    const name = tableMatch[1];
    const tableContent = tableMatch[2];
    if (!isValidCrateName(name)) {
      logWarn(`[sec:cargo] Invalid crate name "${name}" in ${relativeManifest} [${section}] — skipping`);
      return null;
    }

    const version = extractVersionFromInlineTable(tableContent);
    if (version) {
      return { name, constraint: version };
    }

    // No version field — path or git dependency, use "*" as constraint
    return { name, constraint: '*' };
  }

  // Line doesn't match expected formats — could be a comment or malformed
  // Only warn if it looks like it was intended to be a dependency
  if (line.includes('=') && !line.startsWith('#')) {
    const possibleName = line.split('=')[0].trim();
    if (possibleName && /^[a-zA-Z0-9_-]+$/.test(possibleName)) {
      logWarn(`[sec:cargo] Could not parse dependency line in ${relativeManifest} [${section}]: "${line}" — skipping`);
    }
  }

  return null;
}

/**
 * Extract the version field from an inline table string.
 * e.g., from `version = "1.0", features = ["derive"]` → "1.0"
 */
function extractVersionFromInlineTable(tableContent: string): string | null {
  const versionMatch = tableContent.match(/version\s*=\s*"([^"]*)"/);
  if (versionMatch && versionMatch[1].trim() !== '') {
    return versionMatch[1];
  }
  return null;
}

/**
 * Extract the version field from a multi-line table section.
 * e.g., from lines like `version = "1.0"`
 */
function extractVersionFromTable(tableContent: string): string | null {
  const lines = tableContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const versionMatch = trimmed.match(/^version\s*=\s*"([^"]*)"$/);
    if (versionMatch && versionMatch[1].trim() !== '') {
      return versionMatch[1];
    }
  }
  return null;
}

/**
 * Attempt to load resolved versions from Cargo.lock in the given directory.
 * Returns an empty map if Cargo.lock is not available.
 *
 * Cargo.lock format uses [[package]] blocks:
 * ```
 * [[package]]
 * name = "serde"
 * version = "1.0.193"
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'Cargo.lock');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    extractFromCargoLock(lockContent, map);
  } catch (err) {
    logWarn(`[sec:cargo] Failed to parse Cargo.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from Cargo.lock content.
 *
 * Cargo.lock uses [[package]] blocks with name and version fields:
 * ```
 * [[package]]
 * name = "serde"
 * version = "1.0.193"
 * source = "registry+https://github.com/rust-lang/crates.io-index"
 * ```
 */
function extractFromCargoLock(content: string, map: ResolvedVersionMap): void {
  const lines = content.split('\n');
  let currentName: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // New package block
    if (trimmed === '[[package]]') {
      currentName = null;
      continue;
    }

    // Name field within a package block
    if (currentName === null) {
      const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"$/);
      if (nameMatch) {
        currentName = nameMatch[1];
        continue;
      }
    }

    // Version field within a package block (after name is set)
    if (currentName !== null) {
      const versionMatch = trimmed.match(/^version\s*=\s*"([^"]+)"$/);
      if (versionMatch) {
        // Only store the first occurrence (highest version is typically last,
        // but Cargo.lock lists the resolved version for each unique instance)
        if (!map.has(currentName)) {
          map.set(currentName, versionMatch[1]);
        }
        currentName = null;
        continue;
      }
    }

    // Reset on empty line or new section
    if (trimmed === '' || trimmed.startsWith('[')) {
      currentName = null;
    }
  }
}

/**
 * Validate that a crate name follows Rust/Cargo naming conventions.
 * Crate names must be non-empty and contain only alphanumeric characters,
 * hyphens, or underscores.
 */
function isValidCrateName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 64) return false;
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the license field from the [package] section of a Cargo.toml.
 * Handles: license = "MIT" or license = "MIT OR Apache-2.0"
 */
function extractCargoLicense(content: string): string | undefined {
  // Find the [package] section
  const packageSectionMatch = /^\[package\]\s*$/m.exec(content);
  if (!packageSectionMatch) return undefined;

  const startIdx = packageSectionMatch.index + packageSectionMatch[0].length;
  const remaining = content.slice(startIdx);
  // Grab content up to the next section header
  const nextSection = remaining.match(/^\[/m);
  const sectionContent = nextSection ? remaining.slice(0, nextSection.index) : remaining;

  const licenseMatch = sectionContent.match(/^license\s*=\s*"([^"]+)"/m);
  if (licenseMatch && licenseMatch[1].trim() !== '') {
    return licenseMatch[1].trim();
  }
  return undefined;
}
