/**
 * Elixir / Phoenix Framework Resolver
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const phoenixResolver: FrameworkResolver = {
  name: 'phoenix',
  detect(context: ResolutionContext): boolean {
    const mixExs = context.readFile('mix.exs');
    if (mixExs && mixExs.includes(':phoenix')) return true;
    return (
      context.fileExists('lib') &&
      (context.fileExists('config/config.exs') || context.fileExists('mix.exs'))
    );
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Controller')) {
      const id = resolveModule(ref.referenceName, 'controllers', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Live') || ref.referenceName.endsWith('LiveView')) {
      const id = resolveModule(ref.referenceName, 'live', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Channel')) {
      const id = resolveModule(ref.referenceName, 'channels', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (/^[A-Z]/.test(ref.referenceName)) {
      const id = resolveModule(ref.referenceName, 'lib', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    if (!filePath.includes('router.ex') && !filePath.includes('router.exs')) return nodes;

    const httpMethods = /(get|post|put|patch|delete)\s+"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = httpMethods.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const [, method, routePath] = match;
      const name = `${method!.toUpperCase()} ${routePath}`;
      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${routePath}:${line}`,
        kind: 'route', name,
        qualifiedName: `${filePath}::${name}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'elixir', updatedAt: now,
      });
    }

    const resources = /resources\s+"([^"]+)"/g;
    while ((match = resources.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const [, routePath] = match;
      const name = `resources ${routePath}`;
      nodes.push({
        id: `route:${filePath}:resources:${routePath}:${line}`,
        kind: 'route', name,
        qualifiedName: `${filePath}::${name}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'elixir', updatedAt: now,
      });
    }

    const liveRoutes = /live\s+"([^"]+)"/g;
    while ((match = liveRoutes.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const [, routePath] = match;
      const name = `live ${routePath}`;
      nodes.push({
        id: `route:${filePath}:live:${routePath}:${line}`,
        kind: 'route', name,
        qualifiedName: `${filePath}::${name}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'elixir', updatedAt: now,
      });
    }

    return nodes;
  },
};

function resolveModule(name: string, subdir: string, context: ResolutionContext): string | null {
  const snake = toSnake(name);
  const candidates = [
    `lib/${subdir}/${snake}.ex`,
    `lib/${snake}.ex`,
  ];
  for (const p of candidates) {
    if (context.fileExists(p)) {
      const node = context.getNodesInFile(p).find(n => n.kind === 'module' && n.name === name);
      if (node) return node.id;
    }
  }
  for (const file of context.getAllFiles()) {
    if (file.endsWith('.ex') || file.endsWith('.exs')) {
      const node = context.getNodesInFile(file).find(n => n.kind === 'module' && n.name === name);
      if (node) return node.id;
    }
  }
  return null;
}

function toSnake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}
