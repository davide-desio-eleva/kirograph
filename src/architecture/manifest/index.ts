/**
 * Manifest Parser Registry
 *
 * Discovers and dispatches manifest parsers. Each parser handles one or more
 * manifest file types. The registry walks the project looking for manifest files
 * and assigns them to the correct parser.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ManifestParser, ArchPackage } from '../types';
import { npmParser } from './npm';
import { goParser } from './go';
import { cargoParser } from './cargo';
import { pythonParser } from './python';
import { mavenParser } from './maven';
import { gradleParser } from './gradle';
import { csprojParser } from './csproj';
import { sbtParser } from './scala';
import { ocamlParser } from './ocaml';
import { elmParser } from './elm';

// All registered manifest parsers, in priority order
const MANIFEST_PARSERS: ManifestParser[] = [
  npmParser,
  goParser,
  cargoParser,
  pythonParser,
  mavenParser,
  gradleParser,
  csprojParser,
  sbtParser,
  ocamlParser,
  elmParser,
];

// All manifest filenames we care about (for fast lookup during directory walk)
const MANIFEST_FILENAMES = new Set(
  MANIFEST_PARSERS.flatMap(p => p.manifestFiles)
);

// Directories to never descend into when scanning for manifests
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.gradle', '__pycache__',
  '.kirograph', 'vendor', '.cache', 'coverage', '.nyc_output', '_build', '_opam',
  'elm-stuff', 'zig-cache', 'zig-out',
]);

export function getAllManifestParsers(): ManifestParser[] {
  return MANIFEST_PARSERS;
}

export function getManifestParser(name: string): ManifestParser | undefined {
  return MANIFEST_PARSERS.find(p => p.name === name);
}

export function registerManifestParser(parser: ManifestParser): void {
  const idx = MANIFEST_PARSERS.findIndex(p => p.name === parser.name);
  if (idx >= 0) MANIFEST_PARSERS[idx] = parser;
  else MANIFEST_PARSERS.push(parser);
}

export interface ManifestScanOptions {
  include?: string[];
  exclude?: string[];
}

/**
 * Walk projectRoot looking for manifest files, parse each, deduplicate, and
 * return all detected packages. Packages from manifests take priority; the
 * deduplication ensures that a workspace root pom.xml and a sub-module
 * pom.xml don't produce overlapping directory mappings.
 *
 * When scanOptions.include is provided, only manifests within included paths
 * are processed (aligning with the code graph scope).
 */
export async function parseAllManifests(projectRoot: string, scanOptions?: ManifestScanOptions): Promise<ArchPackage[]> {
  let manifestPaths = _findManifests(projectRoot);

  // Filter by include/exclude if provided
  if (scanOptions?.include && scanOptions.include.length > 0) {
    const picomatch = require('picomatch');
    const includeMatchers = scanOptions.include.map((p: string) => picomatch(p));
    const excludeMatchers = (scanOptions.exclude ?? []).map((p: string) => picomatch(p));
    manifestPaths = manifestPaths.filter(absPath => {
      const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
      const included = includeMatchers.some((m: (s: string) => boolean) => m(rel));
      if (!included) return false;
      return !excludeMatchers.some((m: (s: string) => boolean) => m(rel));
    });
  }

  const all: ArchPackage[] = [];
  const seenIds = new Set<string>();

  for (const manifestPath of manifestPaths) {
    const parser = MANIFEST_PARSERS.find(p => p.canParse(manifestPath));
    if (!parser) continue;
    try {
      const pkgs = await parser.parse(manifestPath, projectRoot);
      for (const pkg of pkgs) {
        if (!seenIds.has(pkg.id)) {
          seenIds.add(pkg.id);
          all.push(pkg);
        }
      }
    } catch {
      // Ignore parse errors for individual manifests
    }
  }

  return all;
}

function _findManifests(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        _findManifests(path.join(dir, entry.name), results);
      }
    } else if (entry.isFile()) {
      // Check exact filename or extension match
      if (MANIFEST_FILENAMES.has(entry.name) || entry.name.endsWith('.csproj')) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  return results;
}
