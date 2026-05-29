/**
 * Flutter Framework Resolver
 *
 * Detects Flutter projects and extracts route nodes from:
 *   - MaterialApp(routes: {'/path': (ctx) => MyPage()})
 *   - MaterialApp.router(routerConfig: GoRouter(...))
 *   - GoRouter(routes: [GoRoute(path: '/path', builder: ...)])
 *   - AutoRoute annotations: @RoutePage() on widget classes
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const flutterResolver: FrameworkResolver = {
  name: 'flutter',

  detect(context: ResolutionContext): boolean {
    // Primary signal: pubspec.yaml with a flutter dependency/section
    const pubspec = context.readFile('pubspec.yaml');
    if (pubspec) {
      if (pubspec.includes('flutter:') || pubspec.includes('flutter_hooks:') || pubspec.includes('flutter_riverpod:')) {
        return true;
      }
    }
    // Secondary signal: lib/ directory contains .dart files
    for (const file of context.getAllFiles()) {
      if (file.startsWith('lib/') && file.endsWith('.dart')) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve widget references (names ending with Page, Screen, View, Widget)
    if (/(?:Page|Screen|View|Widget)$/.test(ref.referenceName) && /^[A-Z]/.test(ref.referenceName)) {
      for (const file of context.getAllFiles()) {
        if (!file.endsWith('.dart')) continue;
        const node = context.getNodesInFile(file).find(
          n => n.name === ref.referenceName && (n.kind === 'component' || n.kind === 'class')
        );
        if (node) return { original: ref, targetNodeId: node.id, confidence: 0.8, resolvedBy: 'framework' };
      }
    }
    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    if (!filePath.endsWith('.dart')) return [];
    const nodes: Node[] = [];
    const now = Date.now();

    // 1. MaterialApp static routes map: '/path': (ctx) => WidgetName()
    const materialRoutesPattern = /routes\s*:\s*\{([^}]+)\}/gs;
    let routesBlock: RegExpExecArray | null;
    while ((routesBlock = materialRoutesPattern.exec(content)) !== null) {
      const block = routesBlock[1]!;
      const entryPattern = /['"]([^'"]+)['"]\s*:/g;
      let entry: RegExpExecArray | null;
      while ((entry = entryPattern.exec(block)) !== null) {
        const routePath = entry[1]!;
        const line = content.slice(0, routesBlock.index).split('\n').length;
        nodes.push({
          id: `route:${filePath}:${routePath}:${line}`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: entry[0].length,
          language: 'dart',
          updatedAt: now,
        });
      }
    }

    // 2. GoRouter GoRoute(path: '/path', ...) declarations
    const goRoutePattern = /GoRoute\s*\([^)]*path\s*:\s*['"]([^'"]+)['"]/g;
    let goMatch: RegExpExecArray | null;
    while ((goMatch = goRoutePattern.exec(content)) !== null) {
      const routePath = goMatch[1]!;
      const line = content.slice(0, goMatch.index).split('\n').length;
      // Avoid duplicates from the routes:{} pass above
      const id = `route:${filePath}:${routePath}:${line}`;
      if (!nodes.some(n => n.id === id)) {
        nodes.push({
          id,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: goMatch[0].length,
          language: 'dart',
          updatedAt: now,
        });
      }
    }

    // 3. AutoRoute @RoutePage() annotation — mark the annotated class as a routed page
    const autoRoutePattern = /@RoutePage\(\s*\)\s*\n(?:\s*\n)*\s*class\s+(\w+)/g;
    let autoMatch: RegExpExecArray | null;
    while ((autoMatch = autoRoutePattern.exec(content)) !== null) {
      const widgetName = autoMatch[1]!;
      const line = content.slice(0, autoMatch.index).split('\n').length;
      // Derive a conventional route path from the class name (e.g. LoginPage → /login)
      const routePath = '/' + widgetName.replace(/(?:Page|Screen|View)$/, '').replace(/([A-Z])/g, (_, c, i) => (i > 0 ? '-' : '') + c.toLowerCase());
      const id = `route:${filePath}:${routePath}:${line}`;
      if (!nodes.some(n => n.id === id)) {
        nodes.push({
          id,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: autoMatch[0].length,
          language: 'dart',
          updatedAt: now,
        });
      }
    }

    return nodes;
  },
};
