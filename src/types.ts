/**
 * KiroGraph Type Definitions
 */

export type NodeKind =
  | 'file' | 'module' | 'class' | 'struct' | 'interface' | 'trait' | 'protocol'
  | 'function' | 'method' | 'property' | 'field' | 'variable' | 'constant'
  | 'enum' | 'enum_member' | 'type_alias' | 'namespace' | 'parameter'
  | 'import' | 'export' | 'route' | 'component'
  | 'dependency' | 'vulnerability';

export type EdgeKind =
  | 'contains' | 'calls' | 'imports' | 'exports' | 'extends' | 'implements'
  | 'references' | 'type_of' | 'returns' | 'instantiates' | 'overrides' | 'decorates'
  | 'has_vulnerability' | 'depends_on' | 'declared_in';

export type Language =
  | 'typescript' | 'javascript' | 'tsx' | 'jsx' | 'python' | 'go' | 'rust'
  | 'java' | 'c' | 'cpp' | 'csharp' | 'php' | 'ruby' | 'swift' | 'kotlin'
  | 'dart' | 'svelte' | 'pascal' | 'liquid' | 'elixir'
  | 'scala' | 'lua' | 'zig' | 'bash' | 'ocaml' | 'elm' | 'solidity' | 'vue' | 'objc'
  | 'yaml' | 'hcl' | 'css' | 'scss' | 'html'
  | 'jupyter'
  | 'rescript' | 'sql' | 'r' | 'julia' | 'powershell' | 'perl' | 'astro' | 'gdscript' | 'nix' | 'verilog'
  | 'haskell'
  | 'unknown';

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
  // Complexity metrics (populated when enableComplexity=true)
  complexityCyclomatic?: number;
  complexityCognitive?: number;
  complexityHalstead?: string;  // JSON: {n1,n2,N1,N2,vocabulary,length,volume,difficulty,effort}
  maintainabilityIndex?: number;
  nestingDepth?: number;
}

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  column?: number;
  confidence?: 'extracted' | 'inferred' | 'ambiguous';
  confidenceScore?: number;
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
  embeddableNodeCount: number;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  useVecIndex: boolean;
  semanticEngine: 'cosine' | 'turboquant' | 'turbovec' | 'sqlite-vec' | 'orama' | 'pglite' | 'lancedb' | 'qdrant' | 'typesense';
  turbovecBits?: number;
  vecIndexCount: number;
  engineFallback: string | null;
  frameworks: string[];
  architectureEnabled: boolean;
  architectureStats?: { packages: number; layers: number; packageDeps: number };
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
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving' | 'detecting frameworks' | 'embeddings' | 'architecture' | 'security' | 'docs' | 'data' | 'patterns' | 'retrying';
  current: number;
  total: number;
  currentFile?: string;
  meta?: Record<string, unknown>;
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
  nodesUpdated: number;
  nodesRemoved: number;
  edgesCreated: number;
  edgesRemoved: number;
  filesScanned: number;
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
