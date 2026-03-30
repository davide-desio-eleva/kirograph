/**
 * KiroGraph Type Definitions
 */

export type NodeKind =
  | 'file' | 'module' | 'class' | 'struct' | 'interface' | 'trait' | 'protocol'
  | 'function' | 'method' | 'property' | 'field' | 'variable' | 'constant'
  | 'enum' | 'enum_member' | 'type_alias' | 'namespace' | 'parameter'
  | 'import' | 'export' | 'route' | 'component';

export type EdgeKind =
  | 'contains' | 'calls' | 'imports' | 'exports' | 'extends' | 'implements'
  | 'references' | 'type_of' | 'returns' | 'instantiates' | 'overrides' | 'decorates';

export type Language =
  | 'typescript' | 'javascript' | 'tsx' | 'jsx' | 'python' | 'go' | 'rust'
  | 'java' | 'c' | 'cpp' | 'csharp' | 'php' | 'ruby' | 'swift' | 'kotlin'
  | 'dart' | 'svelte' | 'pascal' | 'liquid' | 'unknown';

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  updatedAt: number;
}

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  column?: number;
}

export interface FileRecord {
  path: string;
  contentHash: string;
  language: Language;
  fileSize: number;
  symbolCount: number;
  indexedAt: number;
}

export interface SearchResult {
  node: Node;
  score: number;
  matchType: 'exact' | 'prefix' | 'fuzzy' | 'semantic';
}

export interface SearchOptions {
  kinds?: NodeKind[];
  languages?: Language[];
  limit?: number;
  minScore?: number;
}

export interface Subgraph {
  nodes: Node[];
  edges: Edge[];
  entryPoints: string[];
}

export interface NodeContext {
  node: Node;
  ancestors: Node[];
  children: Node[];
  callers: Node[];
  callees: Node[];
}

export interface NodeMetrics {
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  callCount: number;
  callerCount: number;
  childCount: number;
}

export interface GraphStats {
  files: number;
  nodes: number;
  edges: number;
  nodesByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
  dbSizeBytes: number;
  embeddingCount: number;
  embeddingsEnabled: boolean;
  frameworks: string[];
}

export interface TaskContext {
  task: string;
  entryPoints: Node[];
  relatedNodes: Node[];
  edges: Edge[];
  codeSnippets: Map<string, string>;
  summary: string;
}

export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: string[];
  duration: number;
}

export interface SyncResult {
  added: string[];
  modified: string[];
  removed: string[];
  nodesCreated: number;
  nodesRemoved: number;
  errors: string[];
  duration: number;
}

// ── Error Classes (re-exported from src/errors.ts for backward compatibility) ──

export {
  KiroGraphError,
  FileError,
  ParseError,
  DatabaseError,
  ConfigError,
} from './errors';
