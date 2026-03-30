/**
 * Go Framework Resolver (Gin, Echo, Fiber, Chi, stdlib)
 *
 * Mirrors CodeGraph src/resolution/frameworks/go.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const goResolver: FrameworkResolver = {
  name: 'go',
  detect(context: ResolutionContext): boolean {
    if (context.readFile('go.mod')) return true;
    return context.getAllFiles().some(f => f.endsWith('.go'));
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const id = resolveInDirs(ref.referenceName, ['handler','handlers','api','routes','controller','controllers'], '.go', 'function', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository') || ref.referenceName.endsWith('Store')) {
      const id = resolveInDirs(ref.referenceName, ['service','services','repository','store','pkg'], '.go', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['model','models','entity','entities','domain','pkg'], '.go', 'struct', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const patterns = [
      /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/g,
      /e\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*["']([^"']+)["']/g,
      /r\.\s*(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g,
      /http\.HandleFunc\s*\(\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;
        const isHandleFunc = pattern.source.includes('HandleFunc');
        const method = isHandleFunc ? 'ANY' : match[1]!.toUpperCase();
        const path = isHandleFunc ? match[1]! : match[2]!;
        const id = `route:${filePath}:${method}:${path}:${line}`;
        if (!nodes.some(n => n.id === id)) {
          nodes.push({ id, kind: 'route', name: `${method} ${path}`, qualifiedName: `${filePath}::${method}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'go', updatedAt: now });
        }
      }
    }
    return nodes;
  },
};

function resolveInDirs(name: string, dirs: string[], ext: string, kind: string | null, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.endsWith(ext) && dirs.some(d => file.includes(`/${d}/`) || file.includes(`/${d}.go`))) {
      const node = context.getNodesInFile(file).find(
        n => n.name === name && (kind === null || n.kind === kind)
      );
      if (node) return node.id;
    }
  }
  return null;
}
