/** Native indexing engine for KiroGraph (config `"engine": "rust"`). See src/core/rust-engine.ts. */

export interface IndexEntry {
  /** Absolute path of a file the engine parses. */
  path?: string
  language?: string
  /** An ExtractedFile from the TypeScript extractor, as JSON. */
  extracted?: string
  /** The file's stat key, taken before it was read; recorded with the file. */
  statKey?: string
}

export interface IndexOptions {
  projectRoot: string
  dbPath: string
  markerPath?: string
  force: boolean
  enableComplexity: boolean
  maxFileSize: number
  trackOversize: boolean
  synchronousOff: boolean
  collectStats: boolean
  collectRemovedIds: boolean
  threads?: number
}

export interface FileWriteResult {
  path: string
  isNew: boolean
  oldNodes: number
  oldEdges: number
  nodes: number
  edges: number
}

export interface IndexResult {
  filesIndexed: number
  nodesCreated: number
  edgesCreated: number
  unchanged: number
  unchangedPaths: string[]
  errors: string[]
  files: FileWriteResult[]
  removedNodeIds: string[]
  timings: Record<string, number>
}

export interface ResolveOptions {
  dbPath: string
  markerPath?: string
  fuzzyThreshold?: number
  synchronousOff?: boolean
}

export interface ResolveResult {
  resolved: number
  remaining: number
  errors: string[]
}

/** Languages the engine parses itself. */
export function nativeLanguages(): string[]
export function engineVersion(): string
/** Extracts and writes the given files, in order, in a background thread. */
export function indexFiles(options: IndexOptions, entries: IndexEntry[], onProgress?: (current: number, total: number) => void): Promise<IndexResult>
/** Resolves every pending reference into edges, in a background thread. */
export function resolveReferences(options: ResolveOptions, onProgress?: (current: number, total: number) => void): Promise<ResolveResult>
/** Extracts one file without writing it, as JSON (parity tests). */
export function extractFileJson(path: string, projectRoot: string, language: string, enableComplexity: boolean): string | null
