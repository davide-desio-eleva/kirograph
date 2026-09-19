/**
 * Python manifest parser.
 * Handles pyproject.toml, setup.py, setup.cfg, requirements.txt.
 *
 * requirements.txt has no name/version/externalDeps of its own for the
 * architecture (import-graph) side — it's listed here purely so the security
 * module's pip plugin (registered under the same 'python' ecosystem key)
 * gets it through manifest discovery at all; see security/manifest/adapter.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ManifestParser, ArchPackage } from '../types';

export const pythonParser: ManifestParser = {
  name: 'python',
  manifestFiles: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
  language: 'python',

  canParse(manifestPath: string): boolean {
    const base = path.basename(manifestPath);
    return base === 'pyproject.toml' || base === 'setup.py' || base === 'setup.cfg' || base === 'requirements.txt';
  },

  async parse(manifestPath: string, projectRoot: string): Promise<ArchPackage[]> {
    let content: string;
    try {
      content = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      return [];
    }

    const base = path.basename(manifestPath);
    let name: string | undefined;
    let version: string | undefined;
    const externalDeps: string[] = [];

    if (base === 'pyproject.toml') {
      name = content.match(/^\[(?:tool\.poetry|project)\][^[]*name\s*=\s*"([^"]+)"/ms)?.[1];
      version = content.match(/^\[(?:tool\.poetry|project)\][^[]*version\s*=\s*"([^"]+)"/ms)?.[1];
      const depsMatch = content.match(/^\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
      if (depsMatch) {
        for (const line of depsMatch[1].split('\n')) {
          const m = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*[=<>!]/);
          if (m && m[1] !== 'python') externalDeps.push(m[1]);
        }
      }
    } else if (base === 'setup.py') {
      name = content.match(/name\s*=\s*['"]([^'"]+)['"]/)?.[1];
      version = content.match(/version\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const installRequires = content.match(/install_requires\s*=\s*\[([^\]]+)\]/s);
      if (installRequires) {
        for (const dep of installRequires[1].matchAll(/['"]([a-zA-Z0-9_.-]+)/g)) {
          externalDeps.push(dep[1]);
        }
      }
    } else if (base === 'setup.cfg') {
      name = content.match(/^name\s*=\s*(.+)/m)?.[1]?.trim();
      version = content.match(/^version\s*=\s*(.+)/m)?.[1]?.trim();
      const depsSection = content.match(/^install_requires\s*=([\s\S]*?)(?=^\[|\Z)/m);
      if (depsSection) {
        for (const line of depsSection[1].split('\n')) {
          const m = line.trim().match(/^([a-zA-Z0-9_.-]+)/);
          if (m) externalDeps.push(m[1]);
        }
      }
    }

    const relDir = path.relative(projectRoot, path.dirname(manifestPath)).replace(/\\/g, '/') || '.';
    const relManifest = path.relative(projectRoot, manifestPath).replace(/\\/g, '/');
    const pkgName = name ?? path.basename(path.dirname(manifestPath));

    return [{
      id: `pkg:python:${relDir}`,
      name: pkgName,
      path: relDir,
      source: 'manifest',
      language: 'python',
      manifestPath: relManifest,
      version,
      externalDeps,
      updatedAt: Date.now(),
    }];
  },
};
