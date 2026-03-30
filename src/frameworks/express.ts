/**
 * Express/Node.js Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/express.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const expressResolver: FrameworkResolver = {
  name: 'express',

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi) return true;
      } catch { /* invalid JSON */ }
    }
    for (const file of context.getAllFiles()) {
      if (file.includes('routes') || file.includes('controllers') || file.includes('middleware')) {
        const content = context.readFile(file);
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
          return true;
        }
      }
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (isMiddlewareName(ref.referenceName)) {
      const id = resolveMiddleware(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    const controllerMatch = ref.referenceName.match(/^(\w+)Controller\.(\w+)$/);
    if (controllerMatch) {
      const id = resolveController(controllerMatch[1]!, controllerMatch[2]!, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    const serviceMatch = ref.referenceName.match(/^(\w+)(Service|Helper|Utils?)\.(\w+)$/);
    if (serviceMatch) {
      const id = resolveService(serviceMatch[1]! + serviceMatch[2]!, serviceMatch[3]!, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const routePattern = /(app|router)\.(get|post|put|patch|delete|all|use)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, , method, path] = match;
      if (method === 'use' && !path?.startsWith('/')) continue;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${path}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
        updatedAt: now,
      });
    }
    return nodes;
  },
};

function isMiddlewareName(name: string): boolean {
  return [/^auth$/i,/^authenticate$/i,/^authorization$/i,/^validate/i,/^sanitize/i,
    /^rateLimit/i,/^cors$/i,/^helmet$/i,/^logger$/i,/^errorHandler$/i,/^notFound$/i,/Middleware$/i,
  ].some(p => p.test(name));
}

function resolveMiddleware(name: string, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.startsWith('middleware') || file.startsWith('middlewares') || file.includes('/middleware/')) {
      const node = context.getNodesInFile(file).find(
        n => n.name.toLowerCase() === name.toLowerCase() ||
             n.name.toLowerCase() === name.replace(/Middleware$/i, '').toLowerCase()
      );
      if (node) return node.id;
    }
  }
  return null;
}

function resolveController(controller: string, method: string, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if ((file.startsWith('controllers') || file.includes('/controllers/')) &&
        file.toLowerCase().includes(controller.toLowerCase())) {
      const node = context.getNodesInFile(file).find(
        n => (n.kind === 'method' || n.kind === 'function') && n.name === method
      );
      if (node) return node.id;
    }
  }
  return null;
}

function resolveService(serviceName: string, method: string, context: ResolutionContext): string | null {
  const dirs = ['services','src/services','helpers','src/helpers','utils','src/utils'];
  for (const file of context.getAllFiles()) {
    if (dirs.some(d => file.startsWith(d) || file.includes(`/${d}/`)) &&
        file.toLowerCase().includes(serviceName.toLowerCase().replace(/(service|helper|utils?)$/i, ''))) {
      const node = context.getNodesInFile(file).find(
        n => (n.kind === 'method' || n.kind === 'function') && n.name === method
      );
      if (node) return node.id;
    }
  }
  return null;
}
