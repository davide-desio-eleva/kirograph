/**
 * NuGet Version Extraction Plugin for KiroGraph-Sec
 *
 * Extends the existing architecture csproj parser to extract version constraints,
 * resolved versions (from packages.lock.json), and dependency scopes for security analysis.
 *
 * Reuses `csprojParser` from `src/architecture/manifest/csproj.ts` for discovery and
 * basic parsing, then layers on version/scope extraction.
 *
 * Handles:
 * - Inline attribute format: `<PackageReference Include="Name" Version="1.0.0"/>`
 * - Multi-line child element format: `<PackageReference Include="Name"><Version>1.0.0</Version></PackageReference>`
 * - Legacy packages.config: `<package id="Name" version="1.0.0" targetFramework="..."/>`
 * - Lock file packages.lock.json for resolved versions
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

/**
 * Resolved version map: package name (lower-cased) → resolved version string.
 * Built from packages.lock.json.
 */
type ResolvedVersionMap = Map<string, string>;

/**
 * Parse a .csproj manifest and extract NuGet dependency declarations
 * with version constraints, scopes, and resolved versions from packages.lock.json.
 * Also parses a packages.config in the same directory if present.
 *
 * @param manifestPath - Absolute path to the .csproj file
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of parsed dependencies with version and scope information
 */
export async function parseNugetManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const manifestDir = path.dirname(manifestPath);
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  // Read the .csproj content
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:nuget] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Attempt to load resolved versions from packages.lock.json
  const resolvedVersions = loadResolvedVersions(manifestDir);

  // Extract project-level license from .csproj
  const license = extractNugetLicense(content);

  const dependencies: ParsedDependency[] = [];

  // Extract from .csproj PackageReference elements
  const csprojDeps = extractPackageReferences(content, relativeManifest);
  for (const dep of csprojDeps) {
    const resolvedVersion = resolvedVersions.get(dep.name.toLowerCase());
    dependencies.push({
      name: dep.name,
      declaredConstraint: dep.constraint,
      resolvedVersion,
      scope: dep.scope,
      ecosystem: 'nuget',
      sourceManifest: relativeManifest,
      ...(license !== undefined ? { license } : {}),
    });
  }

  // Also parse packages.config in the same directory (legacy NuGet)
  const packagesConfigPath = path.join(manifestDir, 'packages.config');
  if (fs.existsSync(packagesConfigPath)) {
    const relativePackagesConfig = path.relative(projectRoot, packagesConfigPath).replace(/\\/g, '/');
    try {
      const packagesConfigContent = fs.readFileSync(packagesConfigPath, 'utf8');
      const legacyDeps = extractPackagesConfig(packagesConfigContent, relativePackagesConfig);
      for (const dep of legacyDeps) {
        const resolvedVersion = resolvedVersions.get(dep.name.toLowerCase());
        dependencies.push({
          name: dep.name,
          declaredConstraint: dep.constraint,
          resolvedVersion,
          scope: dep.scope,
          ecosystem: 'nuget',
          sourceManifest: relativePackagesConfig,
          ...(license !== undefined ? { license } : {}),
        });
      }
    } catch (err) {
      logWarn(`[sec:nuget] Failed to read ${relativePackagesConfig}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Transitive-only packages (present in packages.lock.json but never
  // declared in the .csproj) would otherwise never become a Dependency_Node
  // and would silently skip vulnerability scanning. resolvedVersions already
  // has every package packages.lock.json resolved, direct or transitive
  // (lower-cased — no original casing is retained by the lock parser).
  const directNames = new Set(dependencies.map(d => d.name.toLowerCase()));
  const lockRelativePath = path.relative(projectRoot, path.join(manifestDir, 'packages.lock.json')).replace(/\\/g, '/');
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'nuget',
      sourceManifest: lockRelativePath,
    });
  }

  return dependencies;
}

/**
 * A raw dependency entry extracted from a .csproj or packages.config file.
 */
interface RawDependency {
  name: string;
  constraint: string;
  scope: ParsedDependency['scope'];
}

/**
 * Extract PackageReference entries from .csproj XML content.
 *
 * Handles:
 * - Inline: `<PackageReference Include="Newtonsoft.Json" Version="13.0.1" />`
 * - With PrivateAssets="all": `<PackageReference Include="MSTest.TestFramework" Version="3.1.1" PrivateAssets="all" />`
 * - Multi-line child: `<PackageReference Include="Name"><Version>1.0.0</Version></PackageReference>`
 */
function extractPackageReferences(content: string, relativeManifest: string): RawDependency[] {
  const deps: RawDependency[] = [];

  // Match single-line <PackageReference ... /> and multi-line <PackageReference ...>...</PackageReference>
  // The regex captures the full element including potential child content
  const elementRegex = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let match: RegExpExecArray | null;

  while ((match = elementRegex.exec(content)) !== null) {
    const attributes = match[1] ?? '';
    const innerContent = match[2] ?? '';

    // Extract the Include attribute (package name)
    const includeMatch = attributes.match(/\bInclude\s*=\s*"([^"]+)"/i);
    if (!includeMatch) {
      continue;
    }
    const name = includeMatch[1].trim();
    if (!name) {
      logWarn(`[sec:nuget] Empty Include attribute in PackageReference at ${relativeManifest} — skipping`);
      continue;
    }

    // Determine scope: PrivateAssets="all" indicates a development/build-only dependency
    const privateAssetsMatch = attributes.match(/\bPrivateAssets\s*=\s*"([^"]*)"/i);
    const scope: ParsedDependency['scope'] =
      privateAssetsMatch && privateAssetsMatch[1].toLowerCase() === 'all'
        ? 'development'
        : 'production';

    // Extract version from Version attribute (inline format)
    let constraint: string | null = null;
    const versionAttrMatch = attributes.match(/\bVersion\s*=\s*"([^"]+)"/i);
    if (versionAttrMatch && versionAttrMatch[1].trim() !== '') {
      constraint = versionAttrMatch[1].trim();
    }

    // If no inline version, check for <Version> child element (multi-line format)
    if (!constraint && innerContent) {
      const versionElemMatch = innerContent.match(/<Version\s*>\s*([^<]+)\s*<\/Version>/i);
      if (versionElemMatch && versionElemMatch[1].trim() !== '') {
        constraint = versionElemMatch[1].trim();
      }
    }

    if (!constraint) {
      // Version may be managed centrally (Directory.Packages.props) — use "*"
      constraint = '*';
    }

    deps.push({ name, constraint, scope });
  }

  return deps;
}

/**
 * Extract package entries from a legacy packages.config XML file.
 *
 * Format: `<package id="Newtonsoft.Json" version="13.0.1" targetFramework="net48" />`
 * All packages from packages.config are treated as production scope.
 */
function extractPackagesConfig(content: string, relativeManifest: string): RawDependency[] {
  const deps: RawDependency[] = [];

  const packageRegex = /<package\b([^>]*?)\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = packageRegex.exec(content)) !== null) {
    const attributes = match[1] ?? '';

    const idMatch = attributes.match(/\bid\s*=\s*"([^"]+)"/i);
    if (!idMatch) continue;
    const name = idMatch[1].trim();
    if (!name) {
      logWarn(`[sec:nuget] Empty id attribute in packages.config at ${relativeManifest} — skipping`);
      continue;
    }

    const versionMatch = attributes.match(/\bversion\s*=\s*"([^"]+)"/i);
    const constraint = versionMatch && versionMatch[1].trim() !== '' ? versionMatch[1].trim() : '*';

    deps.push({ name, constraint, scope: 'production' });
  }

  return deps;
}

/**
 * Attempt to load resolved versions from packages.lock.json in the given directory.
 * Returns an empty map if the lock file is not available.
 *
 * packages.lock.json format:
 * ```json
 * {
 *   "version": 1,
 *   "dependencies": {
 *     "net8.0": {
 *       "Newtonsoft.Json": {
 *         "type": "Direct",
 *         "resolved": "13.0.3",
 *         ...
 *       }
 *     }
 *   }
 * }
 * ```
 */
function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  const lockPath = path.join(manifestDir, 'packages.lock.json');
  if (!fs.existsSync(lockPath)) {
    return map;
  }

  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    extractFromPackagesLock(parsed, map);
  } catch (err) {
    logWarn(`[sec:nuget] Failed to parse packages.lock.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/**
 * Extract resolved versions from a parsed packages.lock.json object.
 *
 * Iterates over all target frameworks and their packages, storing
 * the `resolved` version for each package (keyed by lower-cased name).
 */
function extractFromPackagesLock(
  parsed: unknown,
  map: ResolvedVersionMap,
): void {
  if (typeof parsed !== 'object' || parsed === null) return;

  const root = parsed as Record<string, unknown>;
  const dependencies = root['dependencies'];
  if (typeof dependencies !== 'object' || dependencies === null) return;

  // Iterate over target frameworks (e.g. "net8.0", "net48")
  for (const framework of Object.values(dependencies as Record<string, unknown>)) {
    if (typeof framework !== 'object' || framework === null) continue;

    // Iterate over packages within the framework
    for (const [packageName, packageInfo] of Object.entries(framework as Record<string, unknown>)) {
      if (map.has(packageName.toLowerCase())) continue; // first occurrence wins
      if (typeof packageInfo !== 'object' || packageInfo === null) continue;

      const info = packageInfo as Record<string, unknown>;
      const resolved = info['resolved'];
      if (typeof resolved === 'string' && resolved.trim() !== '') {
        map.set(packageName.toLowerCase(), resolved.trim());
      }
    }
  }
}

/**
 * Extract the PackageLicenseExpression from a .csproj file.
 * Handles: <PackageLicenseExpression>MIT</PackageLicenseExpression>
 */
function extractNugetLicense(content: string): string | undefined {
  const match = content.match(/<PackageLicenseExpression\s*>\s*([^<]+)\s*<\/PackageLicenseExpression>/i);
  if (match && match[1].trim() !== '') {
    return match[1].trim();
  }
  return undefined;
}
