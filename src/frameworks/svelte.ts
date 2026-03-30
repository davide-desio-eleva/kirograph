/**
 * Svelte / SvelteKit Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/svelte.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

const SVELTE_RUNES = new Set([
  '$state','$state.raw','$state.snapshot','$derived','$derived.by',
  '$effect','$effect.pre','$effect.root','$effect.tracking',
  '$props','$bindable','$inspect','$host',
]);

const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation','$app/stores','$app/environment','$app/forms','$app/paths',
  '$env/static/private','$env/static/public','$env/dynamic/private','$env/dynamic/public',
];

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.svelte || deps['@sveltejs/kit']) return true;
      } catch { /* invalid JSON */ }
    }
    return context.getAllFiles().some(f => f.endsWith('.svelte'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (SVELTE_RUNES.has(ref.referenceName)) {
      return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('$') && !ref.referenceName.startsWith('$$')) {
      const storeName = ref.referenceName.substring(1);
      const node = context.getNodesByName(storeName).find(
        n => n.kind === 'variable' || n.kind === 'constant'
      );
      if (node) return { original: ref, targetNodeId: node.id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('$')) {
      if (ref.referenceName.startsWith('$lib/')) {
        const libPath = ref.referenceName.replace('$lib/', 'src/lib/');
        for (const ext of ['','.ts','.js','.svelte','/index.ts','/index.js']) {
          const fullPath = libPath + ext;
          if (context.fileExists(fullPath)) {
            const nodes = context.getNodesInFile(fullPath);
            if (nodes.length > 0) return { original: ref, targetNodeId: nodes[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
          }
        }
      }
      if (SVELTEKIT_MODULE_PREFIXES.some(p => ref.referenceName.startsWith(p))) {
        return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
      }
    }
    if (/^[A-Z][a-zA-Z0-9]*$/.test(ref.referenceName) && ref.referenceKind === 'calls') {
      const id = resolveComponent(ref.referenceName, ref.filePath, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extractNodes(filePath: string, _content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const routeMatch = SVELTEKIT_ROUTE_FILES[fileName];
    if (routeMatch) {
      const routePath = filePathToSvelteKitRoute(filePath);
      if (routePath) {
        nodes.push({
          id: `route:${filePath}:${routePath}:1`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
          updatedAt: now,
        });
      }
    }
    return nodes;
  },
};

const SVELTEKIT_ROUTE_FILES: Record<string, string> = {
  '+page.svelte': 'page',
  '+page.ts': 'page-load',
  '+page.js': 'page-load',
  '+page.server.ts': 'page-server-load',
  '+page.server.js': 'page-server-load',
  '+layout.svelte': 'layout',
  '+layout.ts': 'layout-load',
  '+layout.js': 'layout-load',
  '+layout.server.ts': 'layout-server-load',
  '+layout.server.js': 'layout-server-load',
  '+server.ts': 'api-endpoint',
  '+server.js': 'api-endpoint',
  '+error.svelte': 'error-page',
};

function resolveComponent(name: string, fromFile: string, context: ResolutionContext): string | null {
  const allFiles = context.getAllFiles();
  const svelteFiles = allFiles.filter(f => f.endsWith('.svelte'));
  for (const file of svelteFiles) {
    const fileName = file.split(/[/\\]/).pop() || '';
    if (fileName.replace(/\.svelte$/, '') === name) {
      const node = context.getNodesInFile(file).find(n => n.kind === 'component' && n.name === name);
      if (node) return node.id;
    }
  }
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  for (const file of svelteFiles) {
    if (file.startsWith(fromDir)) {
      const fileName = file.split(/[/\\]/).pop() || '';
      if (fileName.replace(/\.svelte$/, '') === name) {
        const node = context.getNodesInFile(file).find(n => n.kind === 'component');
        if (node) return node.id;
      }
    }
  }
  return null;
}

function filePathToSvelteKitRoute(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);
  let route = '/' + dirPath
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?')
    .replace(/\[([^\]]+)\]/g, ':$1');
  if (route === '/') return '/';
  return route.replace(/\/$/, '');
}
