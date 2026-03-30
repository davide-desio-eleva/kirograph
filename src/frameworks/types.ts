/**
 * Framework Resolution Types
 *
 * Mirrors CodeGraph src/resolution/types.ts — types for framework-specific resolvers.
 */

import type { Node, Language } from '../types';

export interface UnresolvedRef {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
  line: number;
  column: number;
  filePath: string;
  language: Language;
}

export interface ResolvedRef {
  original: UnresolvedRef;
  targetNodeId: string;
  confidence: number;
  resolvedBy: 'framework';
}

export interface ResolutionContext {
  getNodesInFile(filePath: string): Node[];
  getNodesByName(name: string): Node[];
  getNodesByKind(kind: Node['kind']): Node[];
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | null;
  getProjectRoot(): string;
  getAllFiles(): string[];
}

export interface FrameworkResolver {
  name: string;
  detect(context: ResolutionContext): boolean;
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  extractNodes?(filePath: string, content: string): Node[];
}
