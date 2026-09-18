/**
 * SecurityManifestAdapter
 *
 * Wraps the existing architecture manifest parsers (11 parsers: npm, cargo, go,
 * gradle, maven, csproj, python, scala, elm, ocaml) to additionally extract
 * version constraints and dependency scopes that the architecture module does
 * not capture.
 *
 * The architecture parsers discover manifest files and extract package names into
 * `ArchPackage.externalDeps`. This adapter reuses that discovery infrastructure
 * and layers version/scope extraction on top via ecosystem-specific plugins.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getAllManifestParsers } from '../../architecture/manifest/index';
import type { ManifestParser as ArchManifestParser, ArchPackage } from '../../architecture/types';
import type { ParsedDependency, ManifestParseResult } from '../types';

// ── Include/Exclude filter support ────────────────────────────────────────────

export interface ManifestScanOptions {
  /** Glob patterns for paths to include (relative to projectRoot). Empty = all. */
  include?: string[];
  /** Glob patterns for paths to exclude (relative to projectRoot). */
  exclude?: string[];
}

// ── Plugin Interface ──────────────────────────────────────────────────────────

/**
 * A version extraction plugin provides ecosystem-specific logic to extract
 * version constraints and scopes from manifest files. Each plugin corresponds
 * to one or more architecture parsers and enhances their output with security-
 * relevant metadata.
 */
export interface VersionExtractionPlugin {
  /** Ecosystem identifier matching the architecture parser name (e.g. 'npm', 'maven', 'go') */
  ecosystem: string;
  /** Manifest filenames this plugin handles (should match the architecture parser's manifestFiles) */
  manifestFiles: string[];
  /** Returns true if this plugin can handle the given manifest file path */
  canExtract(manifestPath: string): boolean;
  /**
   * Extract version constraints and scopes from a manifest file.
   * This is called AFTER the architecture parser has already discovered the manifest.
   * The plugin receives the manifest path and project root, and returns detailed
   * dependency information including versions and scopes.
   */
  extract(manifestPath: string, projectRoot: string): Promise<ParsedDependency[]>;
}

// ── Directories to skip (mirrors architecture module's SKIP_DIRS) ─────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.gradle', '__pycache__',
  '.kirograph', 'vendor', '.cache', 'coverage', '.nyc_output', '_build', '_opam',
  'elm-stuff', 'zig-cache', 'zig-out',
]);

// ── SecurityManifestAdapter ───────────────────────────────────────────────────

export class SecurityManifestAdapter {
  private readonly archParsers: ArchManifestParser[];
  private readonly plugins: Map<string, VersionExtractionPlugin> = new Map();
  /** Standalone plugins have no corresponding architecture parser — they own their own discovery. */
  private readonly standalonePlugins: Map<string, VersionExtractionPlugin> = new Map();
  private readonly projectRoot: string;
  private readonly scanOptions: ManifestScanOptions;

  constructor(projectRoot: string, scanOptions?: ManifestScanOptions) {
    this.projectRoot = projectRoot;
    this.scanOptions = scanOptions ?? {};
    this.archParsers = getAllManifestParsers();
  }

  /**
   * Register a version extraction plugin for an ecosystem that has a
   * corresponding architecture parser. The plugin's `ecosystem` field
   * must equal the architecture parser's `name` for the lookup to work.
   */
  registerPlugin(plugin: VersionExtractionPlugin): void {
    this.plugins.set(plugin.ecosystem, plugin);
  }

  /**
   * Register a standalone version extraction plugin for an ecosystem that
   * has NO corresponding architecture parser. The plugin's `manifestFiles`
   * list drives discovery — the adapter will scan for those filenames and
   * invoke the plugin directly when found.
   */
  registerStandalonePlugin(plugin: VersionExtractionPlugin): void {
    this.standalonePlugins.set(plugin.ecosystem, plugin);
  }

  /**
   * Get all registered version extraction plugins (wrapped + standalone).
   */
  getPlugins(): VersionExtractionPlugin[] {
    return [...this.plugins.values(), ...this.standalonePlugins.values()];
  }

  /**
   * Get the architecture parsers being wrapped.
   */
  getArchParsers(): ArchManifestParser[] {
    return this.archParsers;
  }

  /**
   * Discover all manifest files in the project tree.
   * Includes files known to architecture parsers AND files from standalone plugins.
   * Respects config include/exclude patterns when provided.
   * Returns absolute paths.
   */
  discoverManifests(): string[] {
    const allManifests = this._findManifests(this.projectRoot);

    // If no include patterns, return all discovered manifests
    if (!this.scanOptions.include || this.scanOptions.include.length === 0) {
      return allManifests;
    }

    // Filter manifests to only those within included paths
    const picomatch = require('picomatch');
    const includeMatchers = this.scanOptions.include.map((p: string) => picomatch(p));
    const excludeMatchers = (this.scanOptions.exclude ?? []).map((p: string) => picomatch(p));

    return allManifests.filter(absPath => {
      const rel = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
      const included = includeMatchers.some((m: (s: string) => boolean) => m(rel));
      if (!included) return false;
      const excluded = excludeMatchers.some((m: (s: string) => boolean) => m(rel));
      return !excluded;
    });
  }

  /**
   * Run full discovery and extraction:
   * 1. Discover manifest files (reusing architecture's SKIP_DIRS logic)
   * 2. For each manifest, find the matching architecture parser
   * 3. If a version extraction plugin is registered for that ecosystem,
   *    use it to extract detailed version/scope information
   * 4. Otherwise, fall back to basic extraction from the architecture parser's
   *    ArchPackage.externalDeps (names only, no version info)
   */
  async extractAll(): Promise<ManifestParseResult> {
    const manifestPaths = this.discoverManifests();
    const allDeps: ParsedDependency[] = [];
    const warnings: Array<{ file: string; line?: number; message: string }> = [];
    const errors: Array<{ file: string; message: string }> = [];
    let manifestsParsed = 0;

    for (const manifestPath of manifestPaths) {
      const archParser = this.archParsers.find(p => p.canParse(manifestPath));
      if (!archParser) continue;

      const relManifest = path.relative(this.projectRoot, manifestPath).replace(/\\/g, '/');
      const plugin = this.plugins.get(archParser.name);

      if (plugin && plugin.canExtract(manifestPath)) {
        // Use the version extraction plugin for detailed parsing
        try {
          const deps = await plugin.extract(manifestPath, this.projectRoot);
          allDeps.push(...deps);
          manifestsParsed++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ file: relManifest, message });
        }
      } else {
        // Fallback: use architecture parser output (names only, no versions)
        try {
          const packages = await archParser.parse(manifestPath, this.projectRoot);
          const deps = this._fallbackExtract(packages, archParser.name, relManifest);
          allDeps.push(...deps);
          manifestsParsed++;

          if (!plugin) {
            warnings.push({
              file: relManifest,
              message: `No version extraction plugin registered for ecosystem '${archParser.name}'; dependency names extracted without version constraints`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ file: relManifest, message });
        }
      }
    }

    return {
      dependenciesCreated: allDeps.length,
      manifestsParsed,
      warnings,
      errors,
    };
  }

  /**
   * Extract dependencies for a single manifest file.
   * Tries standalone plugins first (when there is no arch parser), then
   * wrapped plugins, then falls back to arch parser output.
   */
  async extractFromManifest(manifestPath: string): Promise<ParsedDependency[]> {
    const archParser = this.archParsers.find(p => p.canParse(manifestPath));

    if (!archParser) {
      // No arch parser — try standalone plugins
      const standalonePlugin = [...this.standalonePlugins.values()]
        .find(p => p.canExtract(manifestPath));
      if (standalonePlugin) {
        return standalonePlugin.extract(manifestPath, this.projectRoot);
      }
      return [];
    }

    const plugin = this.plugins.get(archParser.name);

    if (plugin && plugin.canExtract(manifestPath)) {
      return plugin.extract(manifestPath, this.projectRoot);
    }

    // Fallback: architecture parser output (names only)
    const packages = await archParser.parse(manifestPath, this.projectRoot);
    const relManifest = path.relative(this.projectRoot, manifestPath).replace(/\\/g, '/');
    return this._fallbackExtract(packages, archParser.name, relManifest);
  }

  /**
   * Get the ecosystem name for a given manifest file path.
   * Returns undefined if no parser handles this file.
   */
  getEcosystem(manifestPath: string): string | undefined {
    const parser = this.archParsers.find(p => p.canParse(manifestPath));
    return parser?.name;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Fallback extraction: converts ArchPackage.externalDeps (names only) into
   * ParsedDependency records with empty version constraints and default scope.
   */
  private _fallbackExtract(
    packages: ArchPackage[],
    ecosystem: string,
    sourceManifest: string,
  ): ParsedDependency[] {
    const deps: ParsedDependency[] = [];
    for (const pkg of packages) {
      if (!pkg.externalDeps) continue;
      for (const depName of pkg.externalDeps) {
        deps.push({
          name: depName,
          declaredConstraint: '*',
          scope: 'production',
          ecosystem,
          sourceManifest,
        });
      }
    }
    return deps;
  }

  /**
   * Walk the project directory tree looking for manifest files.
   * Mirrors the architecture module's _findManifests() logic, respecting SKIP_DIRS.
   * Includes manifest filenames from standalone plugins in addition to arch parsers.
   */
  private _findManifests(dir: string, results: string[] = []): string[] {
    const manifestFilenames = new Set([
      ...this.archParsers.flatMap(p => p.manifestFiles),
      ...Array.from(this.standalonePlugins.values()).flatMap(p => p.manifestFiles),
    ]);

    return this._walkDir(dir, manifestFilenames, results);
  }

  private _walkDir(dir: string, manifestFilenames: Set<string>, results: string[]): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          this._walkDir(path.join(dir, entry.name), manifestFilenames, results);
        }
      } else if (entry.isFile()) {
        if (manifestFilenames.has(entry.name) || entry.name.endsWith('.csproj')) {
          results.push(path.join(dir, entry.name));
        }
      }
    }

    return results;
  }
}
