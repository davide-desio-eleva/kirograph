/**
 * Rust Framework Resolver (Actix-web, Rocket, Axum)
 *
 * Mirrors CodeGraph src/resolution/frameworks/rust.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const rustResolver: FrameworkResolver = {
  name: 'rust',
  detect(context: ResolutionContext): boolean {
    return context.fileExists('Cargo.toml');
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('_handler') || ref.referenceName.startsWith('handle_')) {
      const id = resolveInDirs(ref.referenceName, ['handlers','handler','api','routes','controllers'], '.rs', 'function', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository')) {
      const id = resolveInDirs(ref.referenceName, ['services','service','repository','domain'], '.rs', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['models','model','entities','entity','domain','types'], '.rs', 'struct', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const patterns = [
      /#\[(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g,
      /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;
        const isAxum = pattern.source.includes('\\.route');
        const method = isAxum ? match[2]!.toUpperCase() : match[1]!.toUpperCase();
        const path = isAxum ? match[1]! : match[2]!;
        const id = `route:${filePath}:${method}:${path}:${line}`;
        if (!nodes.some(n => n.id === id)) {
          nodes.push({ id, kind: 'route', name: `${method} ${path}`, qualifiedName: `${filePath}::${method}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'rust', updatedAt: now });
        }
      }
    }
    return nodes;
  },
};

function resolveInDirs(name: string, dirs: string[], ext: string, kind: string | null, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.endsWith(ext) && dirs.some(d => file.includes(`/${d}/`) || file.includes(`/${d}.rs`))) {
      const node = context.getNodesInFile(file).find(
        n => n.name === name && (kind === null || n.kind === kind)
      );
      if (node) return node.id;
    }
  }
  return null;
}
