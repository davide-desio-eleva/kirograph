/**
 * Laravel Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/laravel.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
};

const LARAVEL_HELPERS = new Set(['route','view','config','env','app','abort','redirect','response','request','session','url','asset','mix']);

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  detect(context: ResolutionContext): boolean {
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const modelMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+)::(\w+)$/);
    if (modelMatch) {
      const id = resolveModelCall(modelMatch[1]!, modelMatch[2]!, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (LARAVEL_HELPERS.has(ref.referenceName)) return null;
    const controllerMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+Controller)@(\w+)$/);
    if (controllerMatch) {
      const id = resolveControllerMethod(controllerMatch[1]!, controllerMatch[2]!, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.9, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const routePattern = /Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]+)['"]/g;
    const resourcePattern = /Route::(?:api)?[Rr]esource\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${path}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'php', updatedAt: now });
    }
    while ((match = resourcePattern.exec(content)) !== null) {
      const [, name] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:resource:${name}:${line}`, kind: 'route', name: `resource:${name}`, qualifiedName: `${filePath}::resource:${name}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'php', updatedAt: now });
    }
    return nodes;
  },
};

function resolveModelCall(className: string, methodName: string, context: ResolutionContext): string | null {
  for (const modelPath of [`app/Models/${className}.php`, `app/${className}.php`]) {
    if (context.fileExists(modelPath)) {
      const nodes = context.getNodesInFile(modelPath);
      const node = nodes.find(n => n.kind === 'method' && n.name === methodName) ??
                   nodes.find(n => n.kind === 'class' && n.name === className);
      if (node) return node.id;
    }
  }
  return null;
}

function resolveControllerMethod(controller: string, method: string, context: ResolutionContext): string | null {
  const controllerPath = `app/Http/Controllers/${controller}.php`;
  if (context.fileExists(controllerPath)) {
    const node = context.getNodesInFile(controllerPath).find(n => n.kind === 'method' && n.name === method);
    if (node) return node.id;
  }
  for (const file of context.getAllFiles()) {
    if (file.endsWith(`${controller}.php`) && file.includes('Controllers')) {
      const node = context.getNodesInFile(file).find(n => n.kind === 'method' && n.name === method);
      if (node) return node.id;
    }
  }
  return null;
}
