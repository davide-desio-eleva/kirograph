/**
 * Swift Framework Resolver (SwiftUI, UIKit, Vapor)
 *
 * Mirrors CodeGraph src/resolution/frameworks/swift.ts
 */

import type { Node } from '../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) return true;
      }
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) return true;
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const id = resolveInDirs(ref.referenceName, ['Views','View','Screens','Components','UI'], '.swift', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const id = resolveInDirs(ref.referenceName, ['ViewModels','ViewModel','Stores','Managers','Services'], '.swift', 'class', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const viewPattern = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g;
    let match;
    while ((match = viewPattern.exec(content)) !== null) {
      const [, name] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `view:${filePath}:${name}:${line}`, kind: 'component', name: name!, qualifiedName: `${filePath}::${name}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'swift', updatedAt: now });
    }
    return nodes;
  },
};

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',
  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && (content.includes('import UIKit') || content.includes('UIViewController') || content.includes('UIView'))) return true;
      }
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('ViewController')) {
      const id = resolveInDirs(ref.referenceName, ['ViewControllers','ViewController','Controllers','Screens'], '.swift', 'class', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Cell')) {
      const id = resolveInDirs(ref.referenceName, ['Cells','Cell','Views','TableViewCells','CollectionViewCells'], '.swift', 'class', context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const vcPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g;
    let match;
    while ((match = vcPattern.exec(content)) !== null) {
      const [, name] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `viewcontroller:${filePath}:${name}:${line}`, kind: 'class', name: name!, qualifiedName: `${filePath}::${name}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'swift', updatedAt: now });
    }
    return nodes;
  },
};

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  detect(context: ResolutionContext): boolean {
    const pkg = context.readFile('Package.swift');
    if (pkg && pkg.includes('vapor')) return true;
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) return true;
      }
    }
    return false;
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.endsWith('Controller')) {
      const id = resolveInDirs(ref.referenceName, ['Controllers','Controller','Routes'], '.swift', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Middleware')) {
      const id = resolveInDirs(ref.referenceName, ['Middleware','Middlewares'], '.swift', null, context);
      if (id) return { original: ref, targetNodeId: id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },
  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const routePattern = /\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({ id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`, kind: 'route', name: `${method!.toUpperCase()} ${path}`, qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`, filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'swift', updatedAt: now });
    }
    return nodes;
  },
};

function resolveInDirs(name: string, dirs: string[], ext: string, kind: string | null, context: ResolutionContext): string | null {
  for (const file of context.getAllFiles()) {
    if (file.endsWith(ext) && dirs.some(d => file.includes(`/${d}/`))) {
      const node = context.getNodesInFile(file).find(
        n => n.name === name && (kind === null || n.kind === kind)
      );
      if (node) return node.id;
    }
  }
  return null;
}
