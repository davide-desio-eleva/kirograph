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

  // Extract the project-level license
  const license = extractMavenLicense(content);

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
      ...(license !== undefined ? { license } : {}),
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
 * Extract the first license name from a pom.xml <licenses> block.
 * Looks for: <licenses><license><name>...</name></license></licenses>
 */
function extractMavenLicense(content: string): string | undefined {
  const licensesMatch = content.match(/<licenses\b[^>]*>([\s\S]*?)<\/licenses>/i);
  if (!licensesMatch) return undefined;
  const licenseBlock = licensesMatch[1];
  const nameMatch = licenseBlock.match(/<name>([^<]+)<\/name>/i);
  if (nameMatch && nameMatch[1].trim() !== '') {
    return nameMatch[1].trim();
  }
  return undefined;
}
