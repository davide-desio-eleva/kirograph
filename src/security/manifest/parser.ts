/**
 * ManifestParser Orchestrator
 *
 * Orchestrates manifest discovery, version extraction, deduplication, and
 * database persistence. Uses the SecurityManifestAdapter for discovery and
 * extraction, registers all 12 version extraction plugins:
 *   Wrapped (arch parser exists): npm, maven, go, pip, cargo, nuget, gradle
 *   Standalone (no arch parser):  rubygems, composer, swift, pubspec, hex
 *
 * Node ID format: `dep:<ecosystem>:<name>` (e.g. `dep:npm:express`)
 */
import { SecurityManifestAdapter, type VersionExtractionPlugin, type ManifestScanOptions } from './adapter';
import { parseNpmManifest } from './plugins/npm';
import { parseMavenManifest } from './plugins/maven';
import { parseGoManifest } from './plugins/go';
import { parsePipManifest } from './plugins/pip';
import { parseCargoManifest } from './plugins/cargo';
import { parseNugetManifest } from './plugins/nuget';
import { parseGradleManifest } from './plugins/gradle';
import { parseRubygemsManifest } from './plugins/rubygems';
import { parseComposerManifest } from './plugins/composer';
import { parseSwiftManifest } from './plugins/swift';
import { parsePubspecManifest } from './plugins/pubspec';
import { parseHexManifest } from './plugins/hex';
import { parsePyprojectManifest } from './plugins/pyproject';
import type { GraphDatabase } from '../../db/database';
import type { ParsedDependency, ManifestParseResult } from '../types';
import type { Node, Edge } from '../../types';
import { logWarn, logError } from '../../errors';

// ── Plugin Definitions ────────────────────────────────────────────────────────

/**
 * Create the npm version extraction plugin wrapping parseNpmManifest.
 */
function createNpmPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'npm',
    manifestFiles: ['package.json'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('package.json');
    },
    extract: parseNpmManifest,
  };
}

/**
 * Create the Maven version extraction plugin wrapping parseMavenManifest.
 */
function createMavenPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'maven',
    manifestFiles: ['pom.xml'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('pom.xml');
    },
    extract: parseMavenManifest,
  };
}

/**
 * Create the Go version extraction plugin wrapping parseGoManifest.
 */
function createGoPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'go',
    manifestFiles: ['go.mod'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('go.mod');
    },
    extract: parseGoManifest,
  };
}

/**
 * Create the pip version extraction plugin wrapping parsePipManifest.
 */
function createPipPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'python',
    manifestFiles: ['requirements.txt'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('requirements.txt');
    },
    extract: parsePipManifest,
  };
}

/**
 * Create the Cargo version extraction plugin wrapping parseCargoManifest.
 */
function createCargoPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'cargo',
    manifestFiles: ['Cargo.toml'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('Cargo.toml');
    },
    extract: parseCargoManifest,
  };
}

/**
 * Create the NuGet version extraction plugin wrapping parseNugetManifest.
 * ecosystem = 'csproj' to match the architecture parser name for lookup;
 * ParsedDependency.ecosystem is set to 'nuget' inside the plugin function.
 */
function createNugetPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'csproj',
    manifestFiles: ['.csproj'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('.csproj');
    },
    extract: parseNugetManifest,
  };
}

/**
 * Create the Gradle version extraction plugin wrapping parseGradleManifest.
 */
function createGradlePlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'gradle',
    manifestFiles: ['build.gradle', 'build.gradle.kts'],
    canExtract(manifestPath: string): boolean {
      const base = manifestPath.split('/').pop() ?? '';
      return base === 'build.gradle' || base === 'build.gradle.kts';
    },
    extract: parseGradleManifest,
  };
}

function createPyprojectPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'pyproject',
    manifestFiles: ['pyproject.toml'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('pyproject.toml');
    },
    extract: parsePyprojectManifest,
  };
}

// ── Standalone Plugin Factories ───────────────────────────────────────────────

function createRubygemsPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'rubygems',
    manifestFiles: ['Gemfile'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('/Gemfile') || manifestPath === 'Gemfile';
    },
    extract: parseRubygemsManifest,
  };
}

function createComposerPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'composer',
    manifestFiles: ['composer.json'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('composer.json');
    },
    extract: parseComposerManifest,
  };
}

function createSwiftPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'swift',
    manifestFiles: ['Package.swift'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('Package.swift');
    },
    extract: parseSwiftManifest,
  };
}

function createPubspecPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'pub',
    manifestFiles: ['pubspec.yaml'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('pubspec.yaml');
    },
    extract: parsePubspecManifest,
  };
}

function createHexPlugin(): VersionExtractionPlugin {
  return {
    ecosystem: 'hex',
    manifestFiles: ['mix.exs'],
    canExtract(manifestPath: string): boolean {
      return manifestPath.endsWith('mix.exs');
    },
    extract: parseHexManifest,
  };
}

// ── Version Comparison ────────────────────────────────────────────────────────

/**
 * Compare two version strings. Returns:
 *  - positive if a > b
 *  - negative if a < b
 *  - 0 if equal
 *
 * Handles semver-like versions (1.2.3), Go pseudo-versions, and constraint
 * strings. Falls back to lexicographic comparison for non-numeric versions.
 */
export function compareVersions(a: string, b: string): number {
  // Strip leading 'v' (common in Go modules)
  const cleanA = a.startsWith('v') ? a.slice(1) : a;
  const cleanB = b.startsWith('v') ? b.slice(1) : b;

  // Strip common constraint prefixes (^, ~, >=, <=, =, >, <)
  const numericA = cleanA.replace(/^[~^>=<]+/, '');
  const numericB = cleanB.replace(/^[~^>=<]+/, '');

  const partsA = numericA.split('.');
  const partsB = numericB.split('.');

  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const segA = partsA[i] ?? '0';
    const segB = partsB[i] ?? '0';

    // Try numeric comparison first
    const numA = parseInt(segA, 10);
    const numB = parseInt(segB, 10);

    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) return numA - numB;
      // If numeric parts are equal but segments differ (e.g. "3-beta" vs "3"),
      // compare the remaining suffix
      const suffixA = segA.slice(String(numA).length);
      const suffixB = segB.slice(String(numB).length);
      if (suffixA !== suffixB) {
        // Pre-release suffixes (starting with -) are lower than no suffix
        if (suffixA && !suffixB) return -1;
        if (!suffixA && suffixB) return 1;
        return suffixA.localeCompare(suffixB);
      }
    } else {
      // Lexicographic fallback for non-numeric segments
      const cmp = segA.localeCompare(segB);
      if (cmp !== 0) return cmp;
    }
  }

  return 0;
}

/**
 * Get the effective version string for comparison purposes.
 * Prefers resolvedVersion over declaredConstraint.
 */
function getEffectiveVersion(dep: ParsedDependency): string {
  return dep.resolvedVersion ?? dep.declaredConstraint;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * A deduplicated dependency entry combining data from multiple manifests.
 */
interface DeduplicatedDependency {
  name: string;
  ecosystem: string;
  /** The highest declared constraint across all manifests */
  declaredConstraint: string;
  /** The highest resolved version across all manifests (if any) */
  resolvedVersion?: string;
  /** Scope from the manifest with the highest version */
  scope: ParsedDependency['scope'];
  /** All source manifests that declared this dependency */
  sourceManifests: string[];
  /** License from manifest, if available */
  license?: string;
}

/**
 * Deduplicate dependencies by (name, ecosystem) pair, keeping the entry
 * with the highest version and collecting all source manifests.
 */
export function deduplicateDependencies(deps: ParsedDependency[]): DeduplicatedDependency[] {
  const map = new Map<string, DeduplicatedDependency>();

  for (const dep of deps) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        name: dep.name,
        ecosystem: dep.ecosystem,
        declaredConstraint: dep.declaredConstraint,
        resolvedVersion: dep.resolvedVersion,
        scope: dep.scope,
        sourceManifests: [dep.sourceManifest],
        license: dep.license,
      });
    } else {
      // Add source manifest if not already present
      if (!existing.sourceManifests.includes(dep.sourceManifest)) {
        existing.sourceManifests.push(dep.sourceManifest);
      }

      // Keep the highest version
      const existingVersion = existing.resolvedVersion ?? existing.declaredConstraint;
      const newVersion = getEffectiveVersion(dep);

      if (compareVersions(newVersion, existingVersion) > 0) {
        existing.declaredConstraint = dep.declaredConstraint;
        existing.resolvedVersion = dep.resolvedVersion;
        existing.scope = dep.scope;
        // Update license if the winning version entry has one
        if (dep.license !== undefined) {
          existing.license = dep.license;
        }
      } else if (existing.license === undefined && dep.license !== undefined) {
        // Even if version didn't win, adopt the license if we don't have one
        existing.license = dep.license;
      }
    }
  }

  return [...map.values()];
}

// ── ManifestParser Class ──────────────────────────────────────────────────────

/**
 * ManifestParser orchestrates manifest discovery, parsing, deduplication,
 * and database persistence for the security module.
 */
export class ManifestParser {
  private readonly adapter: SecurityManifestAdapter;
  private readonly db: GraphDatabase;
  private readonly projectRoot: string;

  constructor(db: GraphDatabase, projectRoot: string, scanOptions?: ManifestScanOptions) {
    this.db = db;
    this.projectRoot = projectRoot;
    this.adapter = new SecurityManifestAdapter(projectRoot, scanOptions);

    // Wrapped plugins (arch parser exists — ecosystem must match archParser.name)
    this.adapter.registerPlugin(createNpmPlugin());
    this.adapter.registerPlugin(createMavenPlugin());
    this.adapter.registerPlugin(createGoPlugin());
    this.adapter.registerPlugin(createPipPlugin());
    this.adapter.registerPlugin(createCargoPlugin());
    this.adapter.registerPlugin(createNugetPlugin());
    this.adapter.registerPlugin(createGradlePlugin());

    // Standalone plugins (no arch parser — own manifest discovery via manifestFiles)
    this.adapter.registerStandalonePlugin(createPyprojectPlugin());
    this.adapter.registerStandalonePlugin(createRubygemsPlugin());
    this.adapter.registerStandalonePlugin(createComposerPlugin());
    this.adapter.registerStandalonePlugin(createSwiftPlugin());
    this.adapter.registerStandalonePlugin(createPubspecPlugin());
    this.adapter.registerStandalonePlugin(createHexPlugin());
  }

  /**
   * Get the underlying adapter (useful for testing).
   */
  getAdapter(): SecurityManifestAdapter {
    return this.adapter;
  }

  /**
   * Run full manifest discovery, parsing, deduplication, and database persistence.
   *
   * Steps:
   * 1. Discover manifest files via the adapter (reuses architecture parsers)
   * 2. Extract dependencies with version/scope data via registered plugins
   * 3. Deduplicate: same (name, ecosystem) → single entry with highest version
   * 4. Create Dependency_Nodes in the database (nodes + sec_dependencies tables)
   * 5. Create `declared_in` edges linking dependencies to their source manifests
   */
  async parseAll(): Promise<ManifestParseResult> {
    const warnings: Array<{ file: string; line?: number; message: string }> = [];
    const errors: Array<{ file: string; message: string }> = [];

    // Step 1 & 2: Discover and extract all dependencies
    const allDeps: ParsedDependency[] = [];
    const manifestPaths = this.adapter.discoverManifests();
    let manifestsParsed = 0;

    for (const manifestPath of manifestPaths) {
      try {
        const deps = await this.adapter.extractFromManifest(manifestPath);
        if (deps.length > 0) {
          allDeps.push(...deps);
          manifestsParsed++;
        } else {
          // Manifest was parsed but had no dependencies — still counts
          manifestsParsed++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const relPath = manifestPath.replace(this.projectRoot + '/', '').replace(/\\/g, '/');
        errors.push({ file: relPath, message });
        logError(`[sec:parser] Failed to parse manifest ${relPath}: ${message}`);
      }
    }

    if (allDeps.length === 0) {
      return {
        dependenciesCreated: 0,
        manifestsParsed,
        warnings,
        errors,
      };
    }

    // Step 3: Deduplicate by (name, ecosystem)
    const deduplicated = deduplicateDependencies(allDeps);

    // Step 4 & 5: Persist to database
    let dependenciesCreated = 0;
    const rawDb = this.db.getRawDb();

    for (const dep of deduplicated) {
      try {
        const nodeId = `dep:${dep.ecosystem}:${dep.name}`;

        // Create the node in the nodes table via upsertNode
        const node: Node = {
          id: nodeId,
          kind: 'dependency',
          name: dep.name,
          qualifiedName: `${dep.ecosystem}/${dep.name}`,
          filePath: dep.sourceManifests[0] ?? '',
          language: 'unknown',
          startLine: 0,
          endLine: 0,
          startColumn: 0,
          endColumn: 0,
          signature: dep.resolvedVersion ?? dep.declaredConstraint,
          isExported: false,
          isAsync: false,
          isStatic: false,
          isAbstract: false,
          updatedAt: Date.now(),
        };

        this.db.upsertNode(node);

        // Insert/update the sec_dependencies row
        rawDb.run(
          `INSERT OR REPLACE INTO sec_dependencies
            (node_id, ecosystem, package_name, declared_constraint, resolved_version, scope, source_manifests, license)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nodeId,
            dep.ecosystem,
            dep.name,
            dep.declaredConstraint,
            dep.resolvedVersion ?? null,
            dep.scope,
            JSON.stringify(dep.sourceManifests),
            dep.license ?? null,
          ],
        );

        // Create `declared_in` edges from the dependency to each source manifest
        for (const manifest of dep.sourceManifests) {
          const edge: Edge = {
            source: nodeId,
            target: manifest,
            kind: 'declared_in',
          };
          this.db.insertEdge(edge);
        }

        dependenciesCreated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push({
          file: dep.sourceManifests[0] ?? 'unknown',
          message: `Failed to persist dependency ${dep.ecosystem}/${dep.name}: ${message}`,
        });
        logWarn(`[sec:parser] Failed to persist dependency ${dep.ecosystem}/${dep.name}: ${message}`);
      }
    }

    return {
      dependenciesCreated,
      manifestsParsed,
      warnings,
      errors,
    };
  }
}
