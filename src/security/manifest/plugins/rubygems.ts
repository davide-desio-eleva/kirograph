/**
 * RubyGems Version Extraction Plugin for KiroGraph-Sec
 *
 * Parses Gemfile manifests to extract gem declarations with version constraints,
 * scopes (derived from `group` blocks), and resolved versions from Gemfile.lock.
 *
 * Handles:
 * - `gem 'name', '~> 1.0'` — single version constraint
 * - `gem 'name', '>= 1.0', '< 2.0'` — multiple constraints (joined with ', ')
 * - `gem 'name'` — no version constraint
 * - `group :development, :test do ... end` blocks → 'development' scope
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Resolved version map: gem name → resolved version string.
 * Built from Gemfile.lock.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a Gemfile manifest and extract gem declarations with version constraints,
 * scopes, and resolved versions from Gemfile.lock.
 *
 * @param manifestPath - Absolute path to the Gemfile
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseRubygemsManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the Gemfile content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:rubygems] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from Gemfile.lock
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Attempt to extract license from a gemspec in the same directory
  const license = loadGemspecLicense(manifestDir);

  // Extract dependencies from the Gemfile
  const dependencies: ParsedDependency[] = [];
  const lines = content.split('\n');

  // Track current group scope — null means top-level (production)
  let currentScope: ParsedDependency['scope'] = 'production';
  let groupDepth = 0; // tracks nesting depth inside a group block

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Detect start of a group block: `group :test, :development do`
    const groupMatch = trimmed.match(/^group\s+(.+?)\s+do\s*(?:#.*)?$/);
    if (groupMatch) {
      groupDepth++;
      if (groupDepth === 1) {
        currentScope = resolveGroupScope(groupMatch[1]);
      }
      continue;
    }

    // Detect `end` — only reset scope when we exit the outermost group block
    if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#')) {
      if (groupDepth > 0) {
        groupDepth--;
        if (groupDepth === 0) {
          currentScope = 'production';
        }
      }
      continue;
    }

    // Match gem declarations
    const dep = parseGemLine(trimmed, relativeManifest);
    if (dep) {
      const resolvedVersion = resolvedVersions.get(dep.name);
      dependencies.push({
        name: dep.name,
        declaredConstraint: dep.constraint,
        resolvedVersion,
        scope: currentScope,
        ecosystem: 'rubygems',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Transitive-only gems (present in Gemfile.lock but never declared in the
  // Gemfile) would otherwise never become a Dependency_Node and would
  // silently skip vulnerability scanning. resolvedVersions already has every
  // gem Gemfile.lock resolved, direct or transitive.
  const directNames = new Set(dependencies.map(d => d.name));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'rubygems',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * A raw dependency entry extracted from a Gemfile line.
 */
interface RawDependency {
  name: string;
  constraint: string;
}

/**
 * Parse a single `gem` declaration line from a Gemfile.
 *
 * Handles:
 * - `gem 'name'`
 * - `gem 'name', '~> 1.0'`
 * - `gem "name", "~> 1.0"`
 * - `gem 'name', '>= 1.0', '< 2.0'` (multiple constraints joined with ', ')
 */
function parseGemLine(line: string, relativeManifest: string): RawDependency | null {
  // Strip inline comments
  const withoutComment = line.replace(/\s*#.*$/, '');

  // Match: gem 'name' or gem "name" followed by optional version strings
  const gemMatch = withoutComment.match(/^gem\s+(['"])([^'"]+)\1(.*)?$/);
  if (!gemMatch) return null;

  const name = gemMatch[2].trim();
  const rest = (gemMatch[3] || '').trim();

  if (!isValidGemName(name)) {
    logWarn(`[sec:rubygems] Invalid gem name "${name}" in ${relativeManifest} — skipping`);
    return null;
  }

  // No version constraint
  if (rest === '' || rest.startsWith(':') || rest.startsWith(',\s*:')) {
    return { name, constraint: '*' };
  }

  // Extract all string literals from the rest of the line that look like version constraints
  const versionConstraints: string[] = [];
  const versionPattern = /['"]([^'"]*)['"]/g;
  let versionMatch: RegExpExecArray | null;
  while ((versionMatch = versionPattern.exec(rest)) !== null) {
    const candidate = versionMatch[1].trim();
    // Only capture strings that look like version constraints (start with ~>, >=, <=, !=, >, <, =, or a digit)
    if (/^(~>|>=|<=|!=|>|<|=|\d)/.test(candidate)) {
      versionConstraints.push(candidate);
    }
  }

  if (versionConstraints.length === 0) {
    return { name, constraint: '*' };
  }

  return { name, constraint: versionConstraints.join(', ') };
}

/**
 * Determine the dependency scope from a group specifier string.
 * Any group containing :test or :development maps to 'development'.
 *
 * @param groupSpec - The group specifier string, e.g., `:development, :test`
 */
function resolveGroupScope(groupSpec: string): ParsedDependency['scope'] {
  if (/:test\b/.test(groupSpec) || /:development\b/.test(groupSpec)) {
    return 'development';
  }
  return 'production';
}

/**
 * Validate that a gem name follows RubyGems naming conventions.
 */
function isValidGemName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 128) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

/**
 * Attempt to load resolved versions from Gemfile.lock in the given directory.
 * Returns an empty map if Gemfile.lock is not available.
 *
 * Gemfile.lock GEM section format:
 * ```
 * GEM
 *   remote: https://rubygems.org/
 *   specs:
 *     rails (7.0.4)
 *     rake (13.0.6)
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'Gemfile.lock');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    extractFromGemfileLock(lockContent, map);
  } catch (err) {
    logWarn(`[sec:rubygems] Failed to parse Gemfile.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from Gemfile.lock content.
 *
 * The GEM section contains a `specs:` subsection with lines of the form:
 * `    gemname (1.2.3)` (4-space indent for direct deps, 6-space for sub-deps).
 * We capture all entries under `specs:`.
 */
function extractFromGemfileLock(content: string, map: ResolvedVersionMap): void {
  const lines = content.split('\n');
  let inGemSection = false;
  let inSpecsSection = false;

  for (const line of lines) {
    // Detect top-level section headers (no indent)
    if (/^\S/.test(line)) {
      inGemSection = line.trimEnd() === 'GEM';
      inSpecsSection = false;
      continue;
    }

    if (!inGemSection) continue;

    // Detect `  specs:` subsection (2-space indent)
    if (/^  specs:\s*$/.test(line)) {
      inSpecsSection = true;
      continue;
    }

    if (!inSpecsSection) continue;

    // Parse gem entries: `    gemname (1.2.3)` — 4+ spaces indent
    const specMatch = line.match(/^    ([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s+\(([^)]+)\)\s*$/);
    if (specMatch) {
      const name = specMatch[1];
      const version = specMatch[2].trim();
      if (!map.has(name)) {
        map.set(name, version);
      }
    }
  }
}

/**
 * Attempt to load the license from a .gemspec file in the given directory.
 * Looks for: s.license = 'MIT' or spec.license = "MIT"
 */
function loadGemspecLicense(dir: string): string | undefined {
  try {
    const entries = fs.readdirSync(dir);
    const gemspecFile = entries.find(f => f.endsWith('.gemspec'));
    if (!gemspecFile) return undefined;
    const content = fs.readFileSync(path.join(dir, gemspecFile), 'utf8');
    const match = content.match(/\.license\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[1].trim() !== '') {
      return match[1].trim();
    }
  } catch {
    // best-effort — ignore errors
  }
  return undefined;
}
