/**
 * pyproject.toml Version Extraction Plugin for KiroGraph-Sec
 *
 * Handles modern Python packaging: PEP 621 (standard), Poetry, Hatch, PDM, Flit.
 * pyproject.toml is the canonical manifest for virtually all Python projects
 * created after 2021 — requirements.txt is only used for pinned deployment deps.
 *
 * Supports:
 *   - PEP 621 [project] dependencies = ["package>=1.0"]
 *   - Poetry [tool.poetry.dependencies] { package = "^1.0" }
 *   - PDM [tool.pdm.dev-dependencies] { dev = ["package>=1.0"] }
 *   - Hatch [tool.hatch.envs.default.dependencies] = ["package>=1.0"]
 * Lock files: poetry.lock, pdm.lock, uv.lock (all share the same version extraction)
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedDependency } from '../../types';
import { logWarn } from '../../../errors';

type ResolvedVersionMap = Map<string, string>;

// ── Entry point ───────────────────────────────────────────────────────────────

export async function parsePyprojectManifest(
  manifestPath: string,
  projectRoot: string,
): Promise<ParsedDependency[]> {
  const relativeManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');

  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    logWarn(`[sec:pyproject] Failed to read ${relativeManifest}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const manifestDir = path.dirname(manifestPath);
  const resolvedVersions = loadResolvedVersions(manifestDir);
  const license = extractPyprojectLicense(content);
  const dependencies: ParsedDependency[] = [];

  // ── PEP 621 [project] ──────────────────────────────────────────────────────
  const pep621Deps = extractPep621Dependencies(content, relativeManifest);
  for (const dep of pep621Deps) {
    dependencies.push({
      name: dep.name,
      declaredConstraint: dep.constraint,
      resolvedVersion: resolvedVersions.get(dep.name.toLowerCase()),
      scope: dep.scope,
      ecosystem: 'pypi',
      sourceManifest: relativeManifest,
      ...(license !== undefined ? { license } : {}),
    });
  }

  // ── Poetry [tool.poetry.dependencies] ─────────────────────────────────────
  if (dependencies.length === 0 || hasPoetrySection(content)) {
    const poetryDeps = extractPoetryDependencies(content, relativeManifest);
    for (const dep of poetryDeps) {
      if (!dependencies.find(d => d.name === dep.name)) {
        dependencies.push({
          name: dep.name,
          declaredConstraint: dep.constraint,
          resolvedVersion: resolvedVersions.get(dep.name.toLowerCase()),
          scope: dep.scope,
          ecosystem: 'pypi',
          sourceManifest: relativeManifest,
          ...(license !== undefined ? { license } : {}),
        });
      }
    }
  }

  // ── PDM [tool.pdm.dev-dependencies] ───────────────────────────────────────
  const pdmDeps = extractPdmDependencies(content, relativeManifest);
  for (const dep of pdmDeps) {
    if (!dependencies.find(d => d.name === dep.name)) {
      dependencies.push({
        name: dep.name,
        declaredConstraint: dep.constraint,
        resolvedVersion: resolvedVersions.get(dep.name.toLowerCase()),
        scope: dep.scope,
        ecosystem: 'pypi',
        sourceManifest: relativeManifest,
        ...(license !== undefined ? { license } : {}),
      });
    }
  }

  // Transitive-only packages (present in poetry.lock/pdm.lock/uv.lock but
  // never declared in pyproject.toml) would otherwise never become a
  // Dependency_Node and would silently skip vulnerability scanning.
  // resolvedVersions already has every package the lock file resolved,
  // direct or transitive (lower-cased — original casing isn't retained).
  const directNames = new Set(dependencies.map(d => d.name.toLowerCase()));
  for (const [name, version] of resolvedVersions) {
    if (directNames.has(name)) continue;
    dependencies.push({
      name,
      declaredConstraint: version,
      resolvedVersion: version,
      scope: 'production',
      ecosystem: 'pypi',
      sourceManifest: relativeManifest,
    });
  }

  return dependencies;
}

// ── PEP 621 extraction ────────────────────────────────────────────────────────

interface RawDep { name: string; constraint: string; scope: ParsedDependency['scope'] }

function extractPep621Dependencies(content: string, relativeManifest: string): RawDep[] {
  const deps: RawDep[] = [];

  // [project] dependencies = ["package>=1.0", ...]
  const depsBlock = extractTomlArray(content, /^\[project\]/m, 'dependencies');
  for (const spec of depsBlock) {
    const dep = parsePep508Spec(spec, relativeManifest);
    if (dep) deps.push({ ...dep, scope: 'production' });
  }

  // [project.optional-dependencies] group = ["package>=1.0", ...]
  const optSection = extractSection(content, /^\[project\.optional-dependencies\]/m);
  if (optSection) {
    for (const m of optSection.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=\s*\[([^\]]*)\]/gm)) {
      const groupName = m[1].toLowerCase();
      const isDevGroup = /^(dev|test|lint|docs|ci|build|check|debug)/.test(groupName);
      const items = parseTomlStringArray(m[2]);
      for (const spec of items) {
        const dep = parsePep508Spec(spec, relativeManifest);
        if (dep) deps.push({ ...dep, scope: isDevGroup ? 'development' : 'optional' });
      }
    }
  }

  return deps;
}

// ── Poetry extraction ─────────────────────────────────────────────────────────

function hasPoetrySection(content: string): boolean {
  return /^\[tool\.poetry/m.test(content);
}

function extractPoetryDependencies(content: string, relativeManifest: string): RawDep[] {
  const deps: RawDep[] = [];

  const sections: Array<{ pattern: RegExp; scope: ParsedDependency['scope'] }> = [
    { pattern: /^\[tool\.poetry\.dependencies\]/m, scope: 'production' },
    { pattern: /^\[tool\.poetry\.dev-dependencies\]/m, scope: 'development' },
  ];

  // Also handle [tool.poetry.group.*.dependencies]
  for (const m of content.matchAll(/^\[tool\.poetry\.group\.([a-zA-Z0-9_-]+)\.dependencies\]/gm)) {
    const groupName = m[1].toLowerCase();
    const scope: ParsedDependency['scope'] = /^(dev|test|lint|docs|ci)/.test(groupName) ? 'development' : 'optional';
    sections.push({ pattern: new RegExp(`^\\[tool\\.poetry\\.group\\.${m[1]}\\.dependencies\\]`, 'm'), scope });
  }

  for (const { pattern, scope } of sections) {
    const section = extractSection(content, pattern);
    if (!section) continue;

    for (const line of section.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) break;

      // name = "^1.0" or name = { version = "^1.0", ... }
      const simpleMatch = trimmed.match(/^([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)\s*=\s*"([^"]+)"/);
      if (simpleMatch) {
        const name = simpleMatch[1];
        if (name === 'python') continue; // skip python version constraint
        deps.push({ name: normalizePypiName(name), constraint: simpleMatch[3], scope });
        continue;
      }

      // name = { version = "^1.0", ... }
      const tableMatch = trimmed.match(/^([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)\s*=\s*\{/);
      if (tableMatch) {
        const name = tableMatch[1];
        if (name === 'python') continue;
        const versionMatch = trimmed.match(/version\s*=\s*"([^"]+)"/);
        if (versionMatch) {
          deps.push({ name: normalizePypiName(name), constraint: versionMatch[1], scope });
        } else {
          // path/git dep without version — record with wildcard
          deps.push({ name: normalizePypiName(name), constraint: '*', scope });
        }
      }
    }
  }

  return deps;
}

// ── PDM extraction ────────────────────────────────────────────────────────────

function extractPdmDependencies(content: string, relativeManifest: string): RawDep[] {
  const deps: RawDep[] = [];

  // [tool.pdm.dev-dependencies] groups with arrays
  const section = extractSection(content, /^\[tool\.pdm\.dev-dependencies\]/m);
  if (section) {
    for (const m of section.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=\s*\[([^\]]*)\]/gm)) {
      const items = parseTomlStringArray(m[2]);
      for (const spec of items) {
        const dep = parsePep508Spec(spec, relativeManifest);
        if (dep) deps.push({ ...dep, scope: 'development' });
      }
    }
  }

  return deps;
}

// ── PEP 508 spec parser ───────────────────────────────────────────────────────

function parsePep508Spec(spec: string, _relativeManifest: string): { name: string; constraint: string } | null {
  // PEP 508: name [extras] [version_spec] [; marker]
  // Strip markers (semicolon and beyond), extras ([...])
  const withoutMarker = spec.split(';')[0].trim();
  const withoutExtras = withoutMarker.replace(/\[[^\]]*\]/, '').trim();

  const match = withoutExtras.match(/^([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)\s*(.*)/);
  if (!match) return null;

  const name = normalizePypiName(match[1]);
  const constraint = match[3].trim() || '*';
  return { name, constraint };
}

// ── Lock file loading ─────────────────────────────────────────────────────────

function loadResolvedVersions(manifestDir: string): ResolvedVersionMap {
  const map: ResolvedVersionMap = new Map();

  // Try poetry.lock, pdm.lock, uv.lock in order
  const candidates = ['poetry.lock', 'pdm.lock', 'uv.lock'];
  for (const lockFile of candidates) {
    const lockPath = path.join(manifestDir, lockFile);
    if (!fs.existsSync(lockPath)) continue;
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      if (lockFile === 'poetry.lock') extractFromPoetryLock(content, map);
      else extractFromPdmUvLock(content, map);
      break; // only use the first lock file found
    } catch (err) {
      logWarn(`[sec:pyproject] Failed to parse ${lockFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return map;
}

function extractFromPoetryLock(content: string, map: ResolvedVersionMap): void {
  // [[package]] blocks with name and version fields
  for (const m of content.matchAll(/\[\[package\]\][^[]*?name\s*=\s*"([^"]+)"[^[]*?version\s*=\s*"([^"]+)"/gs)) {
    map.set(m[1].toLowerCase(), m[2]);
  }
}

function extractFromPdmUvLock(content: string, map: ResolvedVersionMap): void {
  // [[package]] or [[distribution]] blocks (pdm/uv use slightly different headers)
  for (const m of content.matchAll(/\[\[(?:package|distribution)\]\][^[]*?name\s*=\s*"([^"]+)"[^[]*?version\s*=\s*"([^"]+)"/gs)) {
    map.set(m[1].toLowerCase(), m[2]);
  }
}

// ── TOML helpers (no library dependency) ─────────────────────────────────────

/** Extract the content after a section header until the next header. */
function extractSection(content: string, headerPattern: RegExp): string | null {
  const match = headerPattern.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remaining = content.slice(start);
  const nextSection = remaining.match(/^\[/m);
  return nextSection ? remaining.slice(0, nextSection.index) : remaining;
}

/** Extract a TOML array value by key from a section. */
function extractTomlArray(content: string, sectionPattern: RegExp, key: string): string[] {
  const section = extractSection(content, sectionPattern);
  if (!section) return [];

  // Match key = ["...", "...", ...] — may span multiple lines
  const keyPattern = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*(?:\\][^\\[\\]]*\\[)*[^\\]]*)\\]`, 'ms');
  const m = keyPattern.exec(section);
  if (!m) return [];
  return parseTomlStringArray(m[1]);
}

/** Parse a TOML string array body (contents inside [...]) into individual strings. */
function parseTomlStringArray(body: string): string[] {
  const results: string[] = [];
  for (const m of body.matchAll(/"([^"]+)"/g)) {
    results.push(m[1].trim());
  }
  for (const m of body.matchAll(/'([^']+)'/g)) {
    results.push(m[1].trim());
  }
  return results.filter(Boolean);
}

/** Normalize PyPI package name: lowercase, replace - and _ with - (canonical form). */
function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Extract the license from a pyproject.toml file.
 *
 * Handles:
 *   - PEP 621 [project] license = {text = "MIT"} or license = "MIT"
 *   - Poetry [tool.poetry] license = "MIT"
 */
function extractPyprojectLicense(content: string): string | undefined {
  // PEP 621: license = {text = "MIT"} or license = {file = "LICENSE"}
  const pep621Section = extractSection(content, /^\[project\]/m);
  if (pep621Section) {
    // license = {text = "MIT"}
    const tableTextMatch = pep621Section.match(/^license\s*=\s*\{[^}]*text\s*=\s*["']([^"']+)["'][^}]*\}/m);
    if (tableTextMatch && tableTextMatch[1].trim() !== '') {
      return tableTextMatch[1].trim();
    }
    // license = "MIT"
    const stringMatch = pep621Section.match(/^license\s*=\s*["']([^"']+)["']/m);
    if (stringMatch && stringMatch[1].trim() !== '') {
      return stringMatch[1].trim();
    }
  }

  // Poetry: [tool.poetry] license = "MIT"
  const poetrySection = extractSection(content, /^\[tool\.poetry\]/m);
  if (poetrySection) {
    const poetryLicenseMatch = poetrySection.match(/^license\s*=\s*["']([^"']+)["']/m);
    if (poetryLicenseMatch && poetryLicenseMatch[1].trim() !== '') {
      return poetryLicenseMatch[1].trim();
    }
  }

  return undefined;
}
