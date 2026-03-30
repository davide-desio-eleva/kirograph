/**
 * C# / ASP.NET Core Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/csharp.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (content && (content.includes('Microsoft.AspNetCore') || content.includes('Microsoft.NET.Sdk.Web') || content.includes('System.Web.Mvc'))) return true;
      }
    }
    const programCs = context.readFile('Program.cs');
    if (programCs && (programCs.includes('WebApplication') || programCs.includes('CreateHostBuilder') || programCs.includes('UseStartup'))) return true;
    if (context.fileExists('Startup.cs')) return true;
    return context.getAllFiles().some(f => f.includes('/Controllers/') && f.endsWith('Controller.cs'));
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Controller')) {
      const id = resolveInDirs(ref.referenceName, ['Controllers'], '.cs', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Service') || (ref.referenceName.startsWith('I') && ref.referenceName.length > 1)) {
      const id = resolveInDirs(ref.referenceName, ['Services','Service','Application'], '.cs', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Repository')) {
      const id = resolveInDirs(ref.referenceName, ['Repositories','Repository','Data','Infrastructure'], '.cs', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['Models','Model','Entities','Entity','Domain'], '.cs', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const httpPattern = /\[(Http(Get|Post|Put|Patch|Delete))\s*(?:\(\s*["']([^"']+)["']\s*\))?\]/g;
    let match;
    while ((match = httpPattern.exec(content)) !== null) {
      const [, , method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      if (path) {
        nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${path}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'csharp', updatedAt: now });
      }
    }
    const minimalPattern = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g;
    while ((match = minimalPattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${path}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'csharp', updatedAt: now });
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
