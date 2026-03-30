/**
 * React Framework Resolver
 *
 * Mirrors CodeGraph src/resolution/frameworks/react.ts
 * Handles React and Next.js patterns.
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const reactResolver: FrameworkResolver = {
  name: 'react',

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) return true;
      } catch { /* invalid JSON */ }
    }
    const allFiles = context.getAllFiles();
    return allFiles.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const id = resolveComponent(ref.referenceName, ref.filePath, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const id = resolveHook(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const id = resolveContext(ref.referenceName, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    const componentPatterns = [
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match;
        const line = content.slice(0, match.index).split('\n').length;
        const afterMatch = content.slice(match.index + fullMatch.length, match.index + fullMatch.length + 500);
        const hasJSX = afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'));
        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            isExported: fullMatch.includes('export'),
            updatedAt: now,
          });
        }
      }
    }

    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g;
    let hookMatch;
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch;
      const line = content.slice(0, hookMatch.index).split('\n').length;
      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: fullMatch.length,
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        isExported: fullMatch.includes('export'),
        updatedAt: now,
      });
    }

    if (filePath.includes('pages/') || filePath.includes('app/')) {
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const line = content.slice(0, content.indexOf('export default')).split('\n').length;
          nodes.push({
            id: `route:${filePath}:${routePath}:${line}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.tsx') ? 'tsx' : filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

function isBuiltInType(name: string): boolean {
  const builtIns = new Set([
    'Array','Boolean','Date','Error','Function','JSON','Math','Number',
    'Object','Promise','RegExp','String','Symbol','Map','Set','WeakMap','WeakSet',
    'React','Component','Fragment','Suspense','StrictMode',
  ]);
  return builtIns.has(name);
}

function resolveComponent(name: string, fromFile: string, context: ResolutionContext): string | null {
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  for (const file of context.getAllFiles().filter(f => f.startsWith(fromDir))) {
    if (file.toLowerCase().includes(name.toLowerCase())) {
      const node = context.getNodesInFile(file).find(
        n => (n.kind === 'component' || n.kind === 'function' || n.kind === 'class') && n.name === name
      );
      if (node) return node.id;
    }
  }
  const componentDirs = ['components','src/components','app/components','pages','src/pages','views','src/views'];
  for (const dir of componentDirs) {
    for (const file of context.getAllFiles()) {
      if (file.startsWith(dir) && file.toLowerCase().includes(name.toLowerCase())) {
        const node = context.getNodesInFile(file).find(
          n => (n.kind === 'component' || n.kind === 'function' || n.kind === 'class') && n.name === name
        );
        if (node) return node.id;
      }
    }
  }
  return null;
}

function resolveHook(name: string, context: ResolutionContext): string | null {
  const hookDirs = ['hooks','src/hooks','lib/hooks','utils/hooks'];
  for (const dir of hookDirs) {
    for (const file of context.getAllFiles()) {
      if (file.startsWith(dir) || file.includes('/hooks/')) {
        const node = context.getNodesInFile(file).find(n => n.kind === 'function' && n.name === name);
        if (node) return node.id;
      }
    }
  }
  const node = context.getNodesByName(name).find(n => n.kind === 'function' && n.name.startsWith('use'));
  return node?.id ?? null;
}

function resolveContext(name: string, context: ResolutionContext): string | null {
  const contextDirs = ['context','contexts','src/context','src/contexts','providers','src/providers'];
  for (const dir of contextDirs) {
    for (const file of context.getAllFiles()) {
      if (file.startsWith(dir) || file.includes('/context/') || file.includes('/contexts/')) {
        const node = context.getNodesInFile(file).find(
          n => n.name === name || n.name === name.replace(/Context$|Provider$/, '')
        );
        if (node) return node.id;
      }
    }
  }
  return null;
}

function filePathToRoute(filePath: string): string | null {
  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');
    if (route === '') route = '/';
    return route;
  }
  if (filePath.includes('app/')) {
    if (!filePath.includes('page.')) return null;
    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');
    if (route === '') route = '/';
    return route.replace(/\/$/, '');
  }
  return null;
}
