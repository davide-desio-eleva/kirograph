/**
 * Gradle Version Extraction Plugin for KiroGraph-Sec
 *
 * Extends the existing architecture gradle parser to extract version constraints,
 * resolved versions (from gradle.lockfile), and dependency scopes for security analysis.
 *
 * Reuses `gradleParser` from `src/architecture/manifest/gradle.ts` for discovery and
 * basic parsing, then layers on version/scope extraction.
 *
 * Handles Groovy DSL (`build.gradle`) and Kotlin DSL (`build.gradle.kts`):
 * - Groovy: `implementation 'group:artifact:version'`
 * - Kotlin: `implementation("group:artifact:version")`
 * - Configuration variants: `api`, `compile`, `testImplementation`, `testApi`,
 *   `androidTestImplementation`, `debugImplementation`, `releaseImplementation`
 * - Version catalog references (`libs.someDep`) are skipped — no version available
 * - Lock file: `gradle.lockfile` for resolved versions
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Gradle dependency configurations mapped to ParsedDependency scope.
 * Configurations not listed here are treated as 'production'.
 */
const TEST_CONFIGURATIONS = new Set([
  'testimplementation',
  'testapi',
  'testcompile',
  'testruntimeonly',
  'androidtestimplementation',
  'androidtestapi',
]);

/**
 * All known Gradle dependency configuration prefixes we parse.
 * Listed from longest to shortest so regex alternation matches greedily.
 */
const KNOWN_CONFIGURATIONS = [
  'androidTestImplementation',
  'androidTestApi',
  'debugImplementation',
  'releaseImplementation',
  'testImplementation',
  'testRuntimeOnly',
  'testCompile',
  'testApi',
  'implementation',
  'runtimeOnly',
  'compileOnly',
  'compile',
  'api',
];

/**
 * Resolved version map: `group:artifact` (lower-cased) → resolved version string.
 * Built from gradle.lockfile.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a Gradle build script (`build.gradle` or `build.gradle.kts`) and extract
 * dependency declarations with version constraints, scopes, and resolved versions
 * from `gradle.lockfile`.
 *
 * @param manifestPath - Absolute path to the build.gradle or build.gradle.kts file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseGradleManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the build script content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:gradle] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from gradle.lockfile
  const resolvedVersions = loadResolvedVersions(manifestDir);

  const dependencies: ParsedDependency[] = [];

  // Build a regex that matches any known configuration followed by a dependency notation
  // Groovy DSL:  implementation 'group:artifact:version'
  //              implementation "group:artifact:version"
  // Kotlin DSL:  implementation("group:artifact:version")
  const configPattern = KNOWN_CONFIGURATIONS.map(c => escapeRegex(c)).join('|');
  // Match: <config> [optional (] ['"] group:artifact:version ['"] [optional )]
  const depRegex = new RegExp(
    `^\\s*(${configPattern})\\s*\\(?\\s*["']([^"']+)["']\\s*\\)?`,
    'gmi',
  );

  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(content)) !== null) {
    const configuration = match[1];
    const notation = match[2].trim();

    const dep = parseGradleNotation(notation, configuration, relativeManifest);
    if (!dep) continue;

    const lookupKey = `${dep.group}:${dep.artifact}`.toLowerCase();
    const resolvedVersion = resolvedVersions.get(lookupKey);

    dependencies.push({
      name: `${dep.group}:${dep.artifact}`,
      declaredConstraint: dep.version,
      resolvedVersion,
      scope: resolveScope(configuration),
      ecosystem: 'gradle',
      sourceManifest: relativeManifest,
    });
  }

  // Transitive-only artifacts (present in gradle.lockfile but never declared
  // in the build script) would otherwise never become a Dependency_Node and
  // would silently skip vulnerability scanning. resolvedVersions already has
  // every "group:artifact" gradle.lockfile resolved, direct or transitive.
  const directNames = new Set(dependencies.map(d => d.name.toLowerCase()));
  for (const [key, version] of resolvedVersions) {
    if (directNames.has(key)) continue;
    dependencies.push({
      name: key,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'gradle',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

/**
 * A parsed Gradle dependency notation (group:artifact:version).
 */
interface GradleCoordinate {
  group: string;
  artifact: string;
  version: string;
}

/**
 * Parse a Gradle dependency notation string of the form `group:artifact:version`.
 *
 * Skips version catalog references (e.g. `libs.someDep`) and notations
 * that do not follow the three-part `group:artifact:version` format.
 */
function parseGradleNotation(
  notation: string,
  configuration: string,
  relativeManifest: string,
): GradleCoordinate | null {
  // Skip version catalog references — they don't carry version info
  if (notation.startsWith('libs.') || notation.startsWith('libs(')) {
    return null;
  }

  const parts = notation.split(':');
  if (parts.length < 2) {
    // Not a standard Maven/Gradle coordinate — skip silently
    return null;
  }

  const group = parts[0].trim();
  const artifact = parts[1].trim();
  const version = parts.length >= 3 ? parts[2].trim() : '';

  if (!group || !artifact) {
    logWarn(`[sec:gradle] Empty group or artifact in notation "${notation}" (${configuration}) at ${relativeManifest} — skipping`);
    return null;
  }

  // Dynamic/incomplete versions (e.g. "+", "", "latest.release") use "*" sentinel
  const normalizedVersion =
    version === '' || version === '+' || version.toLowerCase() === 'latest.release'
      ? '*'
      : version;

  return { group, artifact, version: normalizedVersion };
}

/**
 * Map a Gradle configuration name to a ParsedDependency scope.
 *
 * Test configurations (`testImplementation`, `testApi`, etc.) map to 'development'.
 * All others (including `implementation`, `api`, `compile`, etc.) map to 'production'.
 */
function resolveScope(configuration: string): ParsedDependency['scope'] {
  return TEST_CONFIGURATIONS.has(configuration.toLowerCase()) ? 'development' : 'production';
}

/**
 * Attempt to load resolved versions from `gradle.lockfile` in the given directory.
 * Returns an empty map if the lock file is not available.
 *
 * gradle.lockfile format (one entry per line):
 * ```
 * # This is a comment
 * com.google.guava:guava:32.1.2-jre=compileClasspath,runtimeClasspath
 * junit:junit:4.13.2=testCompileClasspath,testRuntimeClasspath
 * empty=
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'gradle.lockfile');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    extractFromGradleLockfile(content, map);
  } catch (err) {
    logWarn(`[sec:gradle] Failed to parse gradle.lockfile: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from gradle.lockfile content.
 *
 * Each non-comment, non-empty line has the form:
 *   `group:artifact:version=configurationList`
 *
 * The special line `empty=` indicates no locked dependencies and is ignored.
 */
function extractFromGradleLockfile(content: string, map: ResolvedVersionMap): void {
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Skip the sentinel "empty=" line
    if (trimmed === 'empty=') continue;

    // Format: group:artifact:version=configurationList
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const coordinate = trimmed.slice(0, eqIndex).trim();
    const parts = coordinate.split(':');
    if (parts.length < 3) continue;

    const group = parts[0].trim();
    const artifact = parts[1].trim();
    const version = parts[2].trim();

    if (!group || !artifact || !version) continue;

    const key = `${group}:${artifact}`.toLowerCase();
    if (!map.has(key)) {
      map.set(key, version);
    }
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
