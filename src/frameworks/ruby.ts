/**
 * Ruby on Rails Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/ruby.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const railsResolver: FrameworkResolver = {
  name: 'rails',
  detect(context: ResolutionContext): boolean {
    const gemfile = context.readFile('Gemfile');
    if (gemfile && gemfile.includes("'rails'")) return true;
    return context.fileExists('config/application.rb') ||
           context.fileExists('app/controllers/application_controller.rb') ||
           context.fileExists('config/routes.rb');
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const id = resolveModel(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Controller')) {
      const id = resolveController(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Helper')) {
      const id = resolveHelper(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Job')) {
      const id = resolveService(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    if (filePath.includes('routes.rb')) {
      for (const pattern of [
        /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g,
        /resources?\s+:(\w+)/g,
        /root\s+['"]([^'"]+)['"]/g,
      ]) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const line = content.slice(0, match.index).split('\n').length;
          if (pattern.source.includes('resources')) {
            const [, name] = match;
            nodes.push({ id: `route:${filePath}:resource:${name}:${line}`, kind: 'route', name: `resource:${name}`, qualifiedName: `${filePath}::resource:${name}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'ruby', updatedAt: now });
          } else if (pattern.source.includes('root')) {
            const [, target] = match;
            nodes.push({ id: `route:${filePath}:root:${line}`, kind: 'route', name: `/ -> ${target}`, qualifiedName: `${filePath}::root`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'ruby', updatedAt: now });
          } else {
            const [, method, path] = match;
            nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${path}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'ruby', updatedAt: now });
          }
        }
      }
    }
    return nodes;
  },
};

function toSnake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
}

function resolveModel(name: string, context: ResolutionContext): string | null {
  const snake = toSnake(name);
  for (const p of [`app/models/${snake}.rb`, `app/models/concerns/${snake}.rb`]) {
    if (context.fileExists(p)) {
      const node = context.getNodesInFile(p).find(n => n.kind === 'class' && n.name === name);
      if (node) return node.id;
    }
  }
  for (const file of context.getAllFiles()) {
    if (file.includes('app/models/') && file.endsWith('.rb')) {
      const node = context.getNodesInFile(file).find(n => n.kind === 'class' && n.name === name);
      if (node) return node.id;
    }
  }
  return null;
}

function resolveController(name: string, context: ResolutionContext): string | null {
  const snake = toSnake(name);
  for (const p of [`app/controllers/${snake}.rb`, `app/controllers/api/${snake}.rb`]) {
    if (context.fileExists(p)) {
      const node = context.getNodesInFile(p).find(n => n.kind === 'class' && n.name === name);
      if (node) return node.id;
    }
  }
  for (const file of context.getAllFiles()) {
    if (file.includes('controllers/') && file.endsWith('.rb')) {
      const node = context.getNodesInFile(file).find(n => n.kind === 'class' && n.name === name);
      if (node) return node.id;
    }
  }
  return null;
}

function resolveHelper(name: string, context: ResolutionContext): string | null {
  const snake = toSnake(name);
  const p = `app/helpers/${snake}.rb`;
  if (context.fileExists(p)) {
    const node = context.getNodesInFile(p).find(n => n.kind === 'module' && n.name === name);
    if (node) return node.id;
  }
  return null;
}

function resolveService(name: string, context: ResolutionContext): string | null {
  const snake = toSnake(name);
  for (const p of [`app/services/${snake}.rb`, `app/jobs/${snake}.rb`, `app/workers/${snake}.rb`]) {
    if (context.fileExists(p)) {
      const node = context.getNodesInFile(p).find(n => n.kind === 'class' && n.name === name);
      if (node) return node.id;
    }
  }
  return null;
}
