/**
 * Java / Spring Boot Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/java.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  detect(context: ResolutionContext): boolean {
    for (const file of ['pom.xml','build.gradle','build.gradle.kts']) {
      const content = context.readFile(file);
      if (content && (content.includes('spring-boot') || content.includes('springframework'))) return true;
    }
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (content && (content.includes('@SpringBootApplication') || content.includes('@RestController') ||
            content.includes('@Service') || content.includes('@Repository'))) return true;
      }
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Service')) {
      const id = resolveInDirs(ref.referenceName, ['service','services'], '.java', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Repository')) {
      const id = resolveInDirs(ref.referenceName, ['repository','repositories'], '.java', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Controller')) {
      const id = resolveInDirs(ref.referenceName, ['controller','controllers'], '.java', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['entity','entities','model','models','domain'], '.java', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const mappingPattern = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/g;
    let match;
    while ((match = mappingPattern.exec(content)) !== null) {
      const [, type, path] = match;
      const method = type === 'Request' ? 'ANY' : type!.toUpperCase();
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${method}:${path}:${line}`, kind: 'route', name: `${method} ${path}`, qualifiedName: `${filePath}::${method}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'java', updatedAt: now });
    }
    return nodes;
  },
};

function resolveInDirs(name: string, dirs: string[], ext: string, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.endsWith(ext) && dirs.some(d => file.includes(`/${d}/`))) {
      const node = context.getNodesInFile(file).find(
        n => (n.kind === 'class' || n.kind === 'interface') && n.name === name
      );
      if (node) return node.id;
    }
  }
  return null;
}
