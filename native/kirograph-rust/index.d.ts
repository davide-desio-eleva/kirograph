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

export interface GrammarFingerprint {
  language: string
  /** What the compiled grammar has: ABI, parse states, node kinds, fields, hash of the names. */
  abi: number
  states: number
  kinds: number
  fields: number
  hash: string
  /** What grammars/grammars.json records (the WASM file's): both must be equal. */
  recorded: string
}

/** Languages the engine extracts itself (the others are extracted in TypeScript and handed over). */
export function nativeLanguages(): string[]
export function engineVersion(): string
/** Extracts and writes the given files, in order, in a background thread. */
export function indexFiles(options: IndexOptions, entries: IndexEntry[], onProgress?: (current: number, total: number) => void): Promise<IndexResult>
/** The fingerprint of every compiled grammar, with the one grammars/grammars.json records. */
export function grammarFingerprints(): GrammarFingerprint[]
/** Extracts one file without writing it, as JSON (parity tests). */
export function extractFileJson(path: string, projectRoot: string, language: string, enableComplexity: boolean): string | null
