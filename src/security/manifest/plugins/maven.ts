/**
 * Maven Version Extraction Plugin for KiroGraph-Sec
 *
 * Extends the existing architecture maven parser to extract version constraints,
 * dependency scopes, and groupId/artifactId for security analysis.
 *
 * Reuses `mavenParser` from `src/architecture/manifest/maven.ts` for discovery and
 * basic parsing, then layers on version/scope extraction from pom.xml.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Maven scope to ParsedDependency scope mapping.
 *
 * - compile (default), runtime → production
 * - test → development
 * - provided, system → optional
 */
function mapMavenScope(mavenScope: string | undefined): ParsedDependency['scope'] {
  if (!mavenScope || mavenScope.trim() === '') {
    return 'production';
  }

  const normalized = mavenScope.trim().toLowerCase();
  switch (normalized) {
    case 'compile':
    case 'runtime':
      return 'production';
    case 'test':
      return 'development';
    case 'provided':
    case 'system':
      return 'optional';
    default:
      // Unknown scope defaults to production
      return 'production';
  }
}

/**
 * Extract text content from an XML element by tag name within a given XML fragment.
 * Returns undefined if the element is not found.
 */
function extractXmlElement(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : undefined;
}

/**
 * Parse a Maven pom.xml manifest and extract dependency declarations
 * with groupId, artifactId, version constraints, and scopes.
 *
 * @param manifestPath - Absolute path to the pom.xml file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseMavenManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the pom.xml content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:maven] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Validate basic XML structure
  if (!content.includes('<project')) {
    logWarn(`[sec:maven] Invalid pom.xml structure at ${relativeManifest} — missing <project> element`);
    return [];
  }

  // Extract all <dependency> blocks from the <dependencies> sections
  const dependencies: ParsedDependency[] = [];

  // <dependencyManagement> entries (BOM imports, version overrides for child
  // modules) are not themselves project dependencies — strip that block before
  // scanning so they don't get misread as declared dependencies.
  const dependenciesOnlyContent = content.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');

  // Match all <dependency>...</dependency> blocks
  const dependencyBlocks = dependenciesOnlyContent.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g);

  for (const block of dependencyBlocks) {
    const depXml = block[1];

    const groupId = extractXmlElement(depXml, 'groupId');
    const artifactId = extractXmlElement(depXml, 'artifactId');
    const version = extractXmlElement(depXml, 'version');
    const scope = extractXmlElement(depXml, 'scope');

    // Validate required fields
    if (!groupId || groupId.trim() === '') {
      logWarn(`[sec:maven] Missing groupId in dependency at ${relativeManifest} — skipping`);
      continue;
    }

    if (!artifactId || artifactId.trim() === '') {
      logWarn(`[sec:maven] Missing artifactId in dependency at ${relativeManifest} — skipping`);
      continue;
    }

    // Skip dependencies with unresolved Maven properties (e.g. ${project.version})
    if (groupId.includes('${') || artifactId.includes('${')) {
      logWarn(`[sec:maven] Unresolved property in dependency ${groupId}:${artifactId} at ${relativeManifest} — skipping`);
      continue;
    }

    // Build the dependency name as groupId:artifactId (Maven convention)
    const name = `${groupId}:${artifactId}`;

    // Version constraint — may be absent (managed by parent POM or BOM)
    let declaredConstraint: string;
    if (version && version.trim() !== '' && !version.includes('${')) {
      declaredConstraint = version.trim();
    } else {
      // No version or unresolved property — use empty string to indicate managed externally
      declaredConstraint = version && !version.includes('${') ? version.trim() : '';
    }

    const mappedScope = mapMavenScope(scope);

    dependencies.push({
      name,
      declaredConstraint,
      resolvedVersion: declaredConstraint || undefined,
      scope: mappedScope,
      ecosystem: 'maven',
      sourceManifest: relativeManifest,
    });
  }

  // Maven has no lock file, so a <dependency> with no explicit <version> (the
  // common case under a BOM parent like spring-boot-starter-parent) never gets
  // a resolvedVersion above, and packages pulled in only transitively (e.g.
  // tomcat-embed-core via spring-boot-starter-web) never appear in pom.xml at
  // all. If the project has a pre-generated `mvn dependency:tree` text file
  // (the closest Maven equivalent of a lock file), use it to fill in resolved
  // versions and capture transitive-only packages, mirroring how the npm
  // plugin layers package-lock.json on top of package.json.
  const manifestDir = path.dirname(manifestPath);
  const treeFile = findMavenDependencyTreeFile(manifestDir);

  if (treeFile) {
    const treeRelativePath = path.relative(projectRoot, treeFile.path).replace(/\\/g, '/');
    let treeContent: string;
    try {
      treeContent = fs.readFileSync(treeFile.path, 'utf8');
    } catch (err) {
      logWarn(`[sec:maven] Failed to read ${treeRelativePath}: ${err instanceof Error ? err.message : String(err)}`);
      applyLocalMavenLicenses(dependencies);
      return dependencies;
    }

    const treeEntries = parseMavenDependencyTree(treeContent);

    for (const dep of dependencies) {
      if (dep.resolvedVersion) continue;
      const treeEntry = treeEntries.get(dep.name);
      if (treeEntry) {
        dep.resolvedVersion = treeEntry.version;
      }
    }

    const directNames = new Set(dependencies.map(d => d.name));
    for (const [name, entry] of treeEntries) {
      if (directNames.has(name)) continue;
      dependencies.push({
        name,
        // No declared range exists at the project level for a transitive
        // package — the resolved version from the tree is the only constraint we have.
        declaredConstraint: entry.version,
        resolvedVersion: entry.version,
        scope: mapMavenScope(entry.scope),
        ecosystem: 'maven',
        sourceManifest: treeRelativePath,
      });
    }
  }

  applyLocalMavenLicenses(dependencies);
  return dependencies;
}

/**
 * Look for a pre-generated Maven dependency-tree text file next to pom.xml,
 * e.g. produced with:
 *   mvn dependency:tree -DoutputFile=dependency-tree.txt
 * Checked locations, in order: `dependency-tree.txt` next to pom.xml, then
 * `target/dependency-tree.txt` (Maven's default build output directory).
 */
function findMavenDependencyTreeFile(manifestDir: string): { path: string } | undefined {
  const candidates = ['dependency-tree.txt', path.join('target', 'dependency-tree.txt')];
  for (const candidate of candidates) {
    const candidatePath = path.join(manifestDir, candidate);
    if (fs.existsSync(candidatePath)) {
      return { path: candidatePath };
    }
  }
  return undefined;
}

/**
 * Parse `mvn dependency:tree` text output into a map of `groupId:artifactId`
 * to its resolved version and scope.
 *
 * Handles both:
 *   groupId:artifactId:type:version:scope
 *   groupId:artifactId:type:classifier:version:scope
 *
 * Skips the root project line (no scope segment) and parenthesized entries
 * like `(commons-logging:commons-logging:jar:1.1.1:compile - omitted for conflict with 1.2)`
 * — Maven's conflict resolution means only the winning version ends up on the
 * classpath, so omitted entries aren't actually present in the build.
 */
export function parseMavenDependencyTree(content: string): Map<string, { version: string; scope: string }> {
  const result = new Map<string, { version: string; scope: string }>();

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    // Strip Maven's ASCII tree-drawing prefix (e.g. "|  +- ", "   \- ")
    const stripped = rawLine.replace(/^[\s|+\\-]+/, '').trim();
    if (!stripped || stripped.startsWith('(')) continue;

    const parts = stripped.split(':');
    if (parts.length < 5) continue; // root project line ("groupId:artifactId:version") or malformed

    const groupId = parts[0];
    const artifactId = parts[1];
    const version = parts[parts.length - 2];
    const scope = parts[parts.length - 1];
    if (!groupId || !artifactId || !version) continue;

    const name = `${groupId}:${artifactId}`;
    if (!result.has(name)) {
      result.set(name, { version, scope });
    }
  }

  return result;
}

/**
 * Extract every license name from a pom.xml `<licenses>` block, in document
 * order. Looks for: <licenses><license><name>...</name></license>...</licenses>
 * Works on any pom.xml content — the project's own, or a dependency's own
 * POM read from the local Maven repository.
 */
function extractMavenLicenseNames(content: string): string[] {
  const licensesMatch = content.match(/<licenses\b[^>]*>([\s\S]*?)<\/licenses>/i);
  if (!licensesMatch) return [];
  const licenseBlock = licensesMatch[1];
  const names: string[] = [];
  const licenseEntryRegex = /<license\b[^>]*>([\s\S]*?)<\/license>/gi;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = licenseEntryRegex.exec(licenseBlock)) !== null) {
    const nameMatch = entryMatch[1].match(/<name>([^<]+)<\/name>/i);
    if (nameMatch && nameMatch[1].trim() !== '') {
      names.push(nameMatch[1].trim());
    }
  }
  return names;
}

/**
 * Extract a pom.xml's license(s) as a single string. Multiple `<license>`
 * entries (dual/multi-licensed packages) are joined with " OR ", matching
 * the SPDX-expression style already used for npm/Cargo license strings.
 */
function extractMavenLicense(content: string): string | undefined {
  const names = extractMavenLicenseNames(content);
  return names.length > 0 ? names.join(' OR ') : undefined;
}

/**
 * Extract a pom.xml's `<parent>` coordinates, if present.
 * Looks for: <parent><groupId>...</groupId><artifactId>...</artifactId><version>...</version></parent>
 */
function extractMavenParentCoords(content: string): { groupId: string; artifactId: string; version: string } | undefined {
  const parentMatch = content.match(/<parent\b[^>]*>([\s\S]*?)<\/parent>/i);
  if (!parentMatch) return undefined;
  const block = parentMatch[1];
  const groupId = extractXmlElement(block, 'groupId');
  const artifactId = extractXmlElement(block, 'artifactId');
  const version = extractXmlElement(block, 'version');
  if (!groupId || !artifactId || !version) return undefined;
  return { groupId, artifactId, version };
}

/**
 * Resolve the local Maven repository root: `~/.m2/settings.xml`'s
 * `<localRepository>` override if set, else the conventional `~/.m2/repository`.
 */
function resolveMavenLocalRepoRoot(): string {
  const settingsPath = path.join(os.homedir(), '.m2', 'settings.xml');
  try {
    const settings = fs.readFileSync(settingsPath, 'utf8');
    const match = settings.match(/<localRepository>([^<]+)<\/localRepository>/i);
    if (match && match[1].trim() !== '') return match[1].trim();
  } catch {
    // No settings.xml, or unreadable — fall through to the default.
  }
  return path.join(os.homedir(), '.m2', 'repository');
}

/**
 * Maven POMs commonly omit `<licenses>` and inherit it from a `<parent>` POM
 * instead — often several levels up (e.g. commons-codec -> commons-parent ->
 * the ASF parent). This caps how far up that chain is followed, both to
 * bound the number of file reads and to guard against a malformed/cyclic
 * parent reference.
 */
const MAX_MAVEN_PARENT_DEPTH = 10;

/**
 * Each dependency's own license lives in its own POM, not the consuming
 * project's — Maven has no lock file to carry that data, but a dependency
 * that has ever been built or downloaded locally has its POM cached at the
 * standard local-repository layout:
 *   <repoRoot>/<groupId with . -> />/<artifactId>/<version>/<artifactId>-<version>.pom
 * When that POM has no `<licenses>` of its own, its `<parent>` POM is tried
 * next (also read from the local repository), and so on up the chain — this
 * is exactly how Maven itself resolves inherited license metadata.
 * Local files only, no network calls. Returns undefined as soon as a POM in
 * the chain isn't cached locally (e.g. CI running from a clean cache) or no
 * POM in the chain declares a license — same as before this fix, this fills
 * in real data on top of an "unknown" default, it never invents one.
 */
function findLocalMavenPomLicense(repoRoot: string, groupId: string, artifactId: string, version: string): string | undefined {
  let coords: { groupId: string; artifactId: string; version: string } | undefined = { groupId, artifactId, version };

  for (let depth = 0; coords && depth < MAX_MAVEN_PARENT_DEPTH; depth++) {
    const pomPath = path.join(repoRoot, ...coords.groupId.split('.'), coords.artifactId, coords.version, `${coords.artifactId}-${coords.version}.pom`);
    let content: string;
    try {
      content = fs.readFileSync(pomPath, 'utf8');
    } catch {
      return undefined;
    }

    const license = extractMavenLicense(content);
    if (license !== undefined) return license;

    coords = extractMavenParentCoords(content);
  }

  return undefined;
}

/**
 * Fill in `license` for every dependency that has a resolved version, by
 * reading that exact groupId:artifactId:version's own POM from the local
 * Maven repository. Mutates `dependencies` in place.
 */
function applyLocalMavenLicenses(dependencies: ParsedDependency[]): void {
  const repoRoot = resolveMavenLocalRepoRoot();
  for (const dep of dependencies) {
    if (!dep.resolvedVersion) continue;
    const [groupId, artifactId] = dep.name.split(':');
    if (!groupId || !artifactId) continue;
    const license = findLocalMavenPomLicense(repoRoot, groupId, artifactId, dep.resolvedVersion);
    if (license !== undefined) dep.license = license;
  }
}
