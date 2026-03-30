/**
 * Python Framework Resolver (Django, Flask, FastAPI)
 *
 * Mirrors CodeGraph src/resolution/frameworks/python.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const djangoResolver: FrameworkResolver = {
  name: 'django',
  detect(context: ResolutionContext): boolean {
    const req = context.readFile('requirements.txt');
    if (req && req.includes('django')) return true;
    const setup = context.readFile('setup.py');
    if (setup && setup.includes('django')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('django')) return true;
    return context.fileExists('manage.py');
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['models','app/models','src/models'], '.py', 'class', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const id = resolveInDirs(ref.referenceName, ['views','app/views','src/views','api/views'], '.py', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Form')) {
      const id = resolveInDirs(ref.referenceName, ['forms','app/forms','src/forms'], '.py', 'class', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    for (const pattern of [/path\s*\(\s*['"]([^'"]+)['"],\s*(\w+)/g, /url\s*\(\s*r?['"]([^'"]+)['"],\s*(\w+)/g]) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, urlPath] = match;
        const line = content.slice(0, match.index).split('\n').length;
        nodes.push({ id: `route:${filePath}:${urlPath}:${line}`, kind: 'route', name: urlPath!, qualifiedName: `${filePath}::route:${urlPath}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'python', updatedAt: now });
      }
    }
    return nodes;
  },
};

export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  detect(context: ResolutionContext): boolean {
    const req = context.readFile('requirements.txt');
    if (req && (req.includes('flask') || req.includes('Flask'))) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('flask')) return true;
    for (const file of ['app.py','application.py','main.py','__init__.py']) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) return true;
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      for (const file of context.getAllFiles()) {
        if (file.endsWith('.py')) {
          const node = context.getNodesInFile(file).find(n => n.kind === 'variable' && n.name === ref.referenceName);
          if (node) return { original: ref, targetNodeId: node.id, confidence: 0.8, resolvedBy: 'framework' };
        }
      }
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const routePattern = /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, , routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${routePath}:${line}`, kind: 'route', name: routePath!, qualifiedName: `${filePath}::route:${routePath}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'python', updatedAt: now });
    }
    return nodes;
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  detect(context: ResolutionContext): boolean {
    const req = context.readFile('requirements.txt');
    if (req && req.includes('fastapi')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('fastapi')) return true;
    for (const file of ['app.py','main.py','api.py']) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI()')) return true;
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const dirs = ['routers','api','routes','endpoints'];
      for (const file of context.getAllFiles()) {
        if (file.endsWith('.py') && dirs.some(d => file.startsWith(d) || file.includes(`/${d}/`))) {
          const node = context.getNodesInFile(file).find(n => n.kind === 'variable' && n.name === ref.referenceName);
          if (node) return { original: ref, targetNodeId: node.id, confidence: 0.8, resolvedBy: 'framework' };
        }
      }
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const routePattern = /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, , method, routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${routePath}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${routePath}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${routePath}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'python', updatedAt: now });
    }
    return nodes;
  },
};

function resolveInDirs(name: string, dirs: string[], ext: string, kind: string | null, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.endsWith(ext) && dirs.some(d => file.startsWith(d))) {
      const node = context.getNodesInFile(file).find(
        n => n.name === name && (kind === null || n.kind === kind)
      );
      if (node) return node.id;
    }
  }
  return null;
}
