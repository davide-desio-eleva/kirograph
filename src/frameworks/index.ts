/**
 * Framework Resolver Registry
 *
 * Mirrors CodeGraph src/resolution/frameworks/index.ts
 * Manages framework-specific resolvers and detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from '../errors';
import { updateConfig } from '../config';
import type { Node } from '../types';
import type { GraphDatabase } from '../db/database';
import type { FrameworkResolver, ResolutionContext } from './types';

// Re-export types
export type { FrameworkResolver, ResolutionContext, UnresolvedRef, ResolvedRef } from './types';

// Re-export individual resolvers
export { reactResolver } from './react';
export { svelteResolver } from './svelte';
export { expressResolver } from './express';
export { djangoResolver, flaskResolver, fastapiResolver } from './python';
export { railsResolver } from './ruby';
export { springResolver } from './java';
export { goResolver } from './go';
export { rustResolver } from './rust';
export { aspnetResolver } from './csharp';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
export { laravelResolver, FACADE_MAPPINGS } from './laravel';

// ── Registry ──────────────────────────────────────────────────────────────────

import { reactResolver } from './react';
import { svelteResolver } from './svelte';
import { expressResolver } from './express';
import { djangoResolver, flaskResolver, fastapiResolver } from './python';
import { railsResolver } from './ruby';
import { springResolver } from './java';
import { goResolver } from './go';
import { rustResolver } from './rust';
import { aspnetResolver } from './csharp';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
import { laravelResolver } from './laravel';

const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  // JavaScript / TypeScript
  expressResolver,
  reactResolver,
  svelteResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  // Go
  goResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
];

export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS;
}

export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find(r => r.name === name);
}

export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  const index = FRAMEWORK_RESOLVERS.findIndex(r => r.name === resolver.name);
  if (index !== -1) FRAMEWORK_RESOLVERS.splice(index, 1);
  FRAMEWORK_RESOLVERS.push(resolver);
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildResolutionContext(projectRoot: string, db: GraphDatabase): ResolutionContext {
  const fileCache = new Map<string, string | null>();
  const nodeCache = new Map<string, Node[]>();

  return {
    getNodesInFile(filePath: string): Node[] {
      if (!nodeCache.has(filePath)) {
        nodeCache.set(filePath, db.getNodesByFile(filePath));
      }
      return nodeCache.get(filePath)!;
    },
    getNodesByName(name: string): Node[] {
      return db.findNodesByExactName(name);
    },
    getNodesByKind(kind: Node['kind']): Node[] {
      return db.getNodesByKind(kind);
    },
    fileExists(filePath: string): boolean {
      return fs.existsSync(path.join(projectRoot, filePath));
    },
    readFile(filePath: string): string | null {
      if (fileCache.has(filePath)) return fileCache.get(filePath)!;
      try {
        const content = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
        fileCache.set(filePath, content);
        return content;
      } catch {
        fileCache.set(filePath, null);
        return null;
      }
    },
    getProjectRoot(): string {
      return projectRoot;
    },
    getAllFiles(): string[] {
      return db.getAllFiles().map(f => f.path);
    },
  };
}

// ── detectFrameworks ──────────────────────────────────────────────────────────

/**
 * Detect which frameworks are used in a project.
 * Mirrors CodeGraph detectFrameworks() — uses ResolutionContext for file access.
 * Records detected framework names in config via updateConfig().
 */
export async function detectFrameworks(projectRoot: string, db?: GraphDatabase): Promise<FrameworkResolver[]> {
  // If no db provided, fall back to package.json-only detection
  if (!db) {
    return detectFromPackageJson(projectRoot);
  }

  const context = buildResolutionContext(projectRoot, db);
  const detected: FrameworkResolver[] = [];

  for (const resolver of FRAMEWORK_RESOLVERS) {
    try {
      if (resolver.detect(context)) {
        logDebug(`detectFrameworks: detected ${resolver.name}`);
        detected.push(resolver);
      }
    } catch (err) {
      logWarn(`detectFrameworks: error detecting ${resolver.name}`, { error: String(err) });
    }
  }

  if (detected.length > 0) {
    await updateConfig(projectRoot, { frameworkHints: detected.map(f => f.name) });
  }

  return detected;
}

/**
 * Lightweight fallback: detect frameworks from package.json only (no DB needed).
 */
async function detectFromPackageJson(projectRoot: string): Promise<FrameworkResolver[]> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const deps: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };

  const PACKAGE_TO_RESOLVER: Record<string, string> = {
    react: 'react', next: 'react', 'react-native': 'react',
    svelte: 'svelte', '@sveltejs/kit': 'svelte',
    express: 'express', fastify: 'express', koa: 'express',
  };

  const detectedNames = new Set<string>();
  const detected: FrameworkResolver[] = [];

  for (const [pkg, resolverName] of Object.entries(PACKAGE_TO_RESOLVER)) {
    if (Object.prototype.hasOwnProperty.call(deps, pkg) && !detectedNames.has(resolverName)) {
      const resolver = getFrameworkResolver(resolverName);
      if (resolver) {
        detectedNames.add(resolverName);
        detected.push(resolver);
      }
    }
  }

  if (detected.length > 0) {
    await updateConfig(projectRoot, { frameworkHints: detected.map(f => f.name) });
  }

  return detected;
}
