/**
 * KiroGraph — Semantic code knowledge graph for Kiro
 *
 * Pure facade. Every method delegates to a focused sub-system.
 * No business logic lives here.
 */

import * as path from 'path';
import * as fs from 'fs';
import { GraphDatabase } from './db/database';
import { validatePathWithinRoot, validateProjectPath } from './utils';
import { loadConfig, createDefaultConfig, saveConfig } from './config';
import type { KiroGraphConfig } from './config';
import { GraphQueryManager } from './graph/queries';
import { ReferenceResolver } from './resolution/index';
import { VectorManager } from './vectors/index';
import { ContextBuilder } from './context/index';
import { ArchitectureAnalyzer } from './architecture/index';
import { LockManager } from './core/lock-manager';
import { IndexPipeline } from './core/pipeline';
import { buildFileTree } from './core/file-tree';
import { SnapshotManager } from './core/snapshot';
import { Searcher } from './search/searcher';
import type { FileTreeNode, FileTree } from './core/file-tree';
import type { GraphSnapshot, GraphDiff } from './core/snapshot';

export type { GraphSnapshot, GraphDiff };
import type {
  Node, Edge, NodeKind, IndexResult, IndexProgress, SyncResult, TaskContext,
  SearchResult, SearchOptions, NodeContext, NodeMetrics,
} from './types';
import type { ArchitectureResult } from './architecture/types';

export type { FileTreeNode, FileTree };

const KIROGRAPH_DIR = '.kirograph';

export default class KiroGraph {
  private readonly db: GraphDatabase;
  private readonly config: KiroGraphConfig;
  private readonly projectRoot: string;
  private readonly queryManager: GraphQueryManager;
  private readonly resolver: ReferenceResolver;
  private readonly vectors: VectorManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly arch: ArchitectureAnalyzer;
  private readonly lock: LockManager;
  private readonly pipeline: IndexPipeline;
  private readonly searcher: Searcher;

  private constructor(projectRoot: string, db: GraphDatabase, config: KiroGraphConfig) {
    this.projectRoot = projectRoot;
    this.db = db;
    this.config = config;
    this.queryManager = new GraphQueryManager(db);
    this.resolver = new ReferenceResolver(db, config, projectRoot);
    this.vectors = new VectorManager(db, config, projectRoot);
    this.contextBuilder = new ContextBuilder(db, this.resolver, this.vectors, projectRoot);
    this.arch = new ArchitectureAnalyzer(db, config, projectRoot);
    this.lock = new LockManager(projectRoot);
    this.pipeline = new IndexPipeline(db, this.vectors, this.resolver, this.arch, this.lock, config, projectRoot);
    this.searcher = new Searcher(db);
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  static async init(
    projectRoot: string,
    config?: Partial<KiroGraphConfig>,
    onModelProgress?: (file: string, loaded: number, total: number, done: boolean) => void,
  ): Promise<KiroGraph> {
    const resolved = path.resolve(projectRoot);
    validateProjectPath(resolved);
    fs.mkdirSync(path.join(resolved, KIROGRAPH_DIR), { recursive: true });
    const cfg = { ...createDefaultConfig(resolved), ...config };
    await saveConfig(resolved, cfg);
    const db = new GraphDatabase(resolved);
    const kg = new KiroGraph(resolved, db, cfg);
    await kg.vectors.initialize(onModelProgress);
    return kg;
  }

  static async open(
    projectRoot: string,
    onModelProgress?: (file: string, loaded: number, total: number, done: boolean) => void,
  ): Promise<KiroGraph> {
    const resolved = path.resolve(projectRoot);
    validateProjectPath(resolved);
    if (!fs.existsSync(path.join(resolved, KIROGRAPH_DIR))) {
      throw new Error(`KiroGraph not initialized at ${resolved}. Run: kirograph init`);
    }
    const cfg = await loadConfig(resolved);
    const db = new GraphDatabase(resolved);
    const kg = new KiroGraph(resolved, db, cfg);
    await kg.vectors.initialize(onModelProgress);
    return kg;
  }

  static isInitialized(projectRoot: string): boolean {
    return fs.existsSync(path.join(path.resolve(projectRoot), KIROGRAPH_DIR));
  }

  // ── Lock / dirty marker ────────────────────────────────────────────────────

  unlockForce(): void { this.lock.forceRelease(); }
  markDirty(): void { this.lock.markDirty(); }
  clearDirty(): void { this.lock.clearDirty(); }
  isDirty(): boolean { return this.lock.isDirty(); }
  isIndexLocked(): boolean { return this.lock.isLocked(); }

  async syncIfDirty(): Promise<SyncResult | null> {
    if (!this.isDirty()) return null;
    return this.sync();
  }

  /**
   * Returns the number of files that have changed on disk but are not yet
   * reflected in the index. Used by the MCP status tool to warn the agent
   * when the index may be stale.
   */
  async getPendingSyncCount(): Promise<number> {
    try {
      const { getChangedFiles, scanDirectory } = await import('./sync/index');
      const gitChanged = await getChangedFiles(this.projectRoot, this.config);
      const hasGitChanges =
        gitChanged.added.length > 0 ||
        gitChanged.modified.length > 0 ||
        gitChanged.removed.length > 0;

      if (hasGitChanges) {
        return gitChanged.added.length + gitChanged.modified.length + gitChanged.removed.length;
      }

      // Fallback: compare indexed set vs current filesystem set
      const indexed = new Set(this.db.getAllFiles().map((f: { path: string }) => f.path));
      const current = new Set(
        (await scanDirectory(this.projectRoot, this.config))
          .map(f => require('path').relative(this.projectRoot, f).replace(/\\/g, '/'))
      );
      let pending = 0;
      for (const p of indexed) { if (!current.has(p)) pending++; }
      for (const p of current) { if (!indexed.has(p)) pending++; }
      return pending;
    } catch {
      return 0;
    }
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  async indexAll(opts?: { onProgress?: (p: IndexProgress) => void; force?: boolean; signal?: AbortSignal }): Promise<IndexResult> {
    return this.pipeline.indexAll(opts);
  }

  async sync(changedFilesOrOpts?: string[] | { files?: string[]; onProgress?: (p: IndexProgress) => void }): Promise<SyncResult> {
    if (Array.isArray(changedFilesOrOpts)) {
      return this.pipeline.sync({ changedFiles: changedFilesOrOpts });
    }
    return this.pipeline.sync({
      changedFiles: changedFilesOrOpts?.files,
      onProgress: changedFilesOrOpts?.onProgress,
    });
  }

  // ── Symbol search ──────────────────────────────────────────────────────────

  searchNodes(query: string, kindOrOpts?: NodeKind | SearchOptions, limit = 20): SearchResult[] {
    return this.searcher.search(query, kindOrOpts, limit);
  }

  // ── Graph queries ──────────────────────────────────────────────────────────

  async getCallers(nodeId: string, limit = 30): Promise<Node[]> { return this.queryManager.getCallers(nodeId, limit); }
  async getCallees(nodeId: string, limit = 30): Promise<Node[]> { return this.queryManager.getCallees(nodeId, limit); }
  async getImpactRadius(nodeId: string, depth = 2): Promise<Node[]> { return this.queryManager.getImpactRadius(nodeId, depth); }
  getAllNodes(): Node[] { return this.db.getAllNodes(); }
  getAllEdges(): Edge[] { return this.db.getAllEdges(); }
  findDeadCode(limit = 50): Node[] { return this.db.findDeadCode(limit); }
  findCircularDependencies(): string[][] { return this.db.findCircularDependencies(); }
  async findPath(fromId: string, toId: string, maxDepth = 10): Promise<Node[]> { return this.queryManager.findPath(fromId, toId, maxDepth); }
  getTypeHierarchy(nodeId: string, direction: 'up' | 'down' | 'both' = 'both'): Node[] { return this.db.getTypeHierarchy(nodeId, direction); }
  getNode(id: string): Node | null { return this.db.getNode(id); }
  getNodeContext(nodeId: string): NodeContext | null { return this.db.getNodeContext(nodeId); }
  getNodeMetrics(nodeId: string): NodeMetrics { return this.db.getNodeMetrics(nodeId); }

  getNodeSource(node: Node): string | null {
    const absPath = validatePathWithinRoot(path.join(this.projectRoot, node.filePath), this.projectRoot);
    if (!absPath) return null;
    try {
      return fs.readFileSync(absPath, 'utf8').split('\n').slice(node.startLine - 1, node.endLine).join('\n');
    } catch { return null; }
  }

  // ── Context building ───────────────────────────────────────────────────────

  async buildContext(task: string, opts?: { maxNodes?: number; includeCode?: boolean }): Promise<TaskContext> {
    return this.contextBuilder.buildTaskContext(task, opts);
  }

  // ── File browsing ──────────────────────────────────────────────────────────

  getFiles(opts?: { filterPath?: string; pattern?: string; maxDepth?: number }): FileTree {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const picomatch = opts?.pattern ? require('picomatch')(opts.pattern) : null;
    const filtered = this.db.getAllFiles().filter(f => {
      if (opts?.filterPath && !f.path.startsWith(opts.filterPath)) return false;
      if (picomatch && !picomatch(f.path)) return false;
      return true;
    });
    return buildFileTree(filtered, opts?.maxDepth);
  }

  getAffectedTests(changedFiles: string[], opts?: { depth?: number; testPattern?: string }): string[] {
    return this.queryManager.getAffectedTests(changedFiles, opts);
  }

  // ── Graph insights ─────────────────────────────────────────────────────────

  findHotspots(limit = 20): Array<Node & { degree: number; inDegree: number; outDegree: number }> {
    return this.db.findHotspots(limit);
  }

  findSurprisingConnections(limit = 20): Array<{ source: Node; target: Node; kind: string; score: number }> {
    return this.db.findSurprisingConnections(limit);
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  createSnapshotManager(): SnapshotManager {
    return new SnapshotManager(this.db, this.projectRoot);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats() {
    const stats = this.db.getStats();
    const vecIndexCount = await this.vectors.vecIndexCount();
    const embeddingCount = vecIndexCount > 0 ? vecIndexCount : stats.embeddingCount;
    const EMBEDDABLE = ['function', 'method', 'class', 'interface', 'type_alias', 'component', 'module'];
    const embeddableNodeCount = EMBEDDABLE.reduce((sum, k) => sum + (stats.nodesByKind[k] ?? 0), 0);
    const pendingFiles = await this.getPendingSyncCount();
    const syncRunning = this.isIndexLocked();
    return {
      ...stats,
      embeddingCount,
      embeddableNodeCount,
      embeddingsEnabled: this.config.enableEmbeddings ?? false,
      embeddingModel: this.config.embeddingModel,
      useVecIndex: this.config.useVecIndex ?? false,
      semanticEngine: this.config.semanticEngine ?? 'cosine',
      vecIndexCount,
      engineFallback: this.vectors.getEngineFallback(),
      frameworks: this.config.frameworkHints ?? [],
      architectureEnabled: this.config.enableArchitecture ?? false,
      ...(this.config.enableArchitecture ? { architectureStats: this.db.getArchStats() } : {}),
      pendingFiles,
      syncRunning,
      syncWarningThreshold: this.config.syncWarningThreshold ?? 10,
    };
  }

  getEngineFallback(): string | null { return this.vectors.getEngineFallback(); }

  // ── Architecture API ───────────────────────────────────────────────────────

  getArchitecture(): ArchitectureResult & {
    filePackages: Record<string, string[]>;
    fileLayers: Record<string, Array<{ layerId: string; confidence: number; matchedPattern: string }>>;
  } {
    const base = this.db.getArchitectureResult();

    const filePackages: Record<string, string[]> = {};
    for (const { filePath, packageId } of this.db.getArchFilePackages()) {
      if (!filePackages[filePath]) filePackages[filePath] = [];
      filePackages[filePath].push(packageId);
    }

    const fileLayers: Record<string, Array<{ layerId: string; confidence: number; matchedPattern: string }>> = {};
    for (const row of this.db.getArchFileLayers()) {
      if (!fileLayers[row.filePath]) fileLayers[row.filePath] = [];
      fileLayers[row.filePath].push({ layerId: row.layerId, confidence: row.confidence, matchedPattern: row.matchedPattern });
    }

    return { ...base, filePackages, fileLayers };
  }

  isArchitectureEnabled(): boolean { return this.config.enableArchitecture ?? false; }

  // ── Misc ───────────────────────────────────────────────────────────────────

  getProjectRoot(): string { return this.projectRoot; }

  getDatabase(): GraphDatabase { return this.db; }

  close(): void {
    this.vectors.close();
    this.lock.release();
    this.db.close();
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/** Walk up directories to find the nearest .kirograph/ folder. */
export function findNearestKiroGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, KIROGRAPH_DIR))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
