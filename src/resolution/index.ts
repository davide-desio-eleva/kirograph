/**
 * KiroGraph Reference Resolver
 *
 * Implements the warm-cache resolution engine with multiple strategies.
 * Mirrors CodeGraph src/resolution/index.ts
 */

import type { Node, NodeKind, Edge } from '../types';
import type { GraphDatabase } from '../db/database';
import type { KiroGraphConfig } from '../config';
import { matchReference } from './name-matcher';
import { logDebug, logWarn } from '../errors';
import { runBridgeResolvers, type BridgeResolutionResult } from './bridges';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolutionResult {
  resolved: number;
  unresolved: number;
  total: number;
  durationMs: number;
  bridgeResult?: BridgeResolutionResult;
}

// ── ReferenceResolver ─────────────────────────────────────────────────────────

export class ReferenceResolver {
  private db: GraphDatabase;
  private config: KiroGraphConfig;
  private projectRoot: string;

  // Warm caches for O(1) lookup
  private nameCache: Map<string, Node[]> = new Map();
  private qualifiedNameCache: Map<string, Node> = new Map();
  private kindCache: Map<NodeKind, Node[]> = new Map();
  private lowerNameCache: Map<string, Node[]> = new Map();
  private nodeByIdCache: Map<string, Node> = new Map();
  // namespace prefix → first non-import node ID (for C#/Java namespace-level imports)
  private namespacePrefixCache: Map<string, string> = new Map();

  private cacheWarmed = false;

  constructor(db: GraphDatabase, config: KiroGraphConfig, projectRoot?: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot ?? '';
  }

  /**
   * Pre-load all nodes into Maps for O(1) lookup.
   * Must be called before resolveUnresolvedRefs() for best performance.
   */
  warmCaches(): void {
    this.nameCache.clear();
    this.qualifiedNameCache.clear();
    this.kindCache.clear();
    this.lowerNameCache.clear();
    this.nodeByIdCache.clear();
    this.namespacePrefixCache.clear();

    // Access the underlying db instance to query all nodes
    const rawDb = (this.db as any).db;
    const rows: any[] = rawDb.all('SELECT * FROM nodes');

    for (const row of rows) {
      const node: Node = this._rowToNode(row);

      // nameCache
      const nameList = this.nameCache.get(node.name) ?? [];
      nameList.push(node);
      this.nameCache.set(node.name, nameList);

      // qualifiedNameCache
      if (node.qualifiedName) {
        this.qualifiedNameCache.set(node.qualifiedName, node);
      }

      // kindCache
      const kindList = this.kindCache.get(node.kind) ?? [];
      kindList.push(node);
      this.kindCache.set(node.kind, kindList);

      // lowerNameCache
      const lower = node.name.toLowerCase();
      const lowerList = this.lowerNameCache.get(lower) ?? [];
      lowerList.push(node);
      this.lowerNameCache.set(lower, lowerList);

      // nodeByIdCache
      this.nodeByIdCache.set(node.id, node);
    }

    // Build namespace prefix cache for C#/Java namespace-level import resolution.
    // For each class/interface with a dotted qualifiedName, record every ancestor
    // namespace prefix → the node ID, so "using MyApp.Services" resolves O(1).
    for (const [qualName, node] of this.qualifiedNameCache) {
      if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'namespace' || node.kind === 'module') {
        const parts = qualName.split('.');
        for (let k = 1; k < parts.length; k++) {
          const prefix = parts.slice(0, k).join('.');
          if (!this.namespacePrefixCache.has(prefix)) {
            this.namespacePrefixCache.set(prefix, node.id);
          }
        }
      }
    }

    this.cacheWarmed = true;
    logDebug(`ReferenceResolver: warmed caches with ${rows.length} nodes`);
  }

  /**
   * Resolve all pending unresolved references.
   * Warms caches first, then processes all pending refs.
   * Returns a ResolutionResult with counts and duration.
   */
  async resolveAll(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    const start = Date.now();

    this.warmCaches();
    const resolvedCount = await this.resolveUnresolvedRefs(onProgress);

    // Count remaining unresolved
    const rawDb = (this.db as any).db;
    const remaining = rawDb.get('SELECT COUNT(*) as c FROM unresolved_refs')?.c ?? 0;
    const total = resolvedCount + remaining;

    // Run cross-language bridge resolvers after standard resolution
    let bridgeResult: BridgeResolutionResult | undefined;
    if (this.projectRoot) {
      bridgeResult = this._runBridgeResolvers();
    }

    const durationMs = Date.now() - start;
    logDebug(`ReferenceResolver: resolved ${resolvedCount}/${total} refs in ${durationMs}ms`);

    return {
      resolved: resolvedCount,
      unresolved: remaining,
      total,
      durationMs,
      bridgeResult,
    };
  }

  /**
   * Process all pending unresolved references using warm caches.
   * Returns the count of newly resolved edges.
   */
  async resolveUnresolvedRefs(onProgress?: (current: number, total: number) => void): Promise<number> {
    if (!this.cacheWarmed) {
      this.warmCaches();
    }

    const rawDb = (this.db as any).db;
    const refs: any[] = rawDb.all('SELECT * FROM unresolved_refs');
    let resolved = 0;
    const total = refs.length;

    // Process in batched transactions to avoid WASM heap exhaustion.
    // Without batching, each individual write allocates journal pages in the
    // WASM linear memory, which can exceed the 2GB limit on large codebases.
    const BATCH_SIZE = 1000;

    // Skip the expensive "scan all nodes" fuzzy fallback for very large graphs.
    // The O(N*M) cost is prohibitive and the WASM heap cannot sustain it.
    const FUZZY_ALL_NODES_LIMIT = 200_000;
    const skipFullFuzzy = this.nodeByIdCache.size > FUZZY_ALL_NODES_LIMIT;
    if (skipFullFuzzy) {
      logDebug(`ReferenceResolver: skipping full-scan fuzzy (${this.nodeByIdCache.size} nodes exceeds ${FUZZY_ALL_NODES_LIMIT} limit)`);
    }

    for (let batchStart = 0; batchStart < refs.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, refs.length);

      // Wrap each batch in a transaction — dramatically reduces write amplification
      rawDb.run('BEGIN');
      try {
        for (let i = batchStart; i < batchEnd; i++) {
          const ref = refs[i];
          onProgress?.(i + 1, total);
          const {
            id: refId,
            source_id: sourceId,
            ref_name: refName,
            ref_kind: refKind,
            file_path: filePath,
            line,
            column,
          } = ref;

          const attemptedStrategies: string[] = [];
          let targetId: string | null = null;

          if (refKind === 'import') {
            attemptedStrategies.push('import-path');
            targetId = this._resolveImportPath(refName, filePath);
          } else if (refKind === 'extends' || refKind === 'implements') {
            attemptedStrategies.push('type-name');
            targetId = this._resolveTypeName(refName);
          } else {
            attemptedStrategies.push('framework');

            // Strategy 2: Qualified name match (confidence 0.95)
            attemptedStrategies.push('qualified');
            const qualifiedNode = this.qualifiedNameCache.get(refName);
            if (qualifiedNode) {
              targetId = qualifiedNode.id;
            }

            // Strategy 3: Method call pattern (confidence 0.85)
            if (!targetId && refName.includes('.')) {
              attemptedStrategies.push('method');
              const methodPart = refName.slice(refName.lastIndexOf('.') + 1);
              const methodCandidates = this.nameCache.get(methodPart) ?? [];
              if (methodCandidates.length > 0) {
                targetId = methodCandidates[0].id;
              }
            }

            // Strategy 4: Exact name match (confidence 0.9)
            if (!targetId) {
              attemptedStrategies.push('exact');
              const exactCandidates = this.nameCache.get(refName) ?? [];
              if (exactCandidates.length > 0) {
                targetId = exactCandidates[0].id;
              }
            }

            // Strategy 5: Fuzzy / lowercase match (confidence 0.5)
            if (!targetId) {
              attemptedStrategies.push('fuzzy');
              const threshold = this.config.fuzzyResolutionThreshold ?? 0.5;
              const lowerRef = refName.toLowerCase();
              const fuzzyCandidates = this.lowerNameCache.get(lowerRef) ?? [];

              if (fuzzyCandidates.length > 0) {
                const match = matchReference(refName, fuzzyCandidates, threshold);
                if (match) {
                  targetId = match.nodeId;
                }
              }

              // Full-scan fuzzy: only for smaller graphs (O(N*M) is too expensive otherwise)
              if (!targetId && !skipFullFuzzy) {
                const allCandidates = [...this.nodeByIdCache.values()];
                const match = matchReference(refName, allCandidates, threshold);
                if (match) {
                  targetId = match.nodeId;
                }
              }
            }
          }

          if (targetId) {
            const edgeKind = refKind === 'import' ? 'imports'
              : refKind === 'extends' ? 'extends'
              : refKind === 'implements' ? 'implements'
              : 'calls';
            const edge: Edge = {
              source: sourceId,
              target: targetId,
              kind: edgeKind,
              line: line ?? undefined,
              column: column ?? undefined,
            };
            this.db.insertEdge(edge);
            rawDb.run('DELETE FROM unresolved_refs WHERE id = ?', [refId]);
            resolved++;
          } else {
            const strategiesJson = JSON.stringify(attemptedStrategies);
            try {
              rawDb.run(
                'UPDATE unresolved_refs SET attempted_strategies = ? WHERE id = ?',
                [strategiesJson, refId]
              );
            } catch {
              logWarn(`ReferenceResolver: failed to record attempted strategies for ref ${refId}`);
            }
          }
        }
        rawDb.run('COMMIT');
      } catch (err) {
        // Roll back the failed batch but continue with remaining batches
        try { rawDb.run('ROLLBACK'); } catch { /* already rolled back */ }
        logWarn(`ReferenceResolver: batch ${batchStart}-${batchEnd} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return resolved;
  }

  /**
   * Invalidate cache entries for all nodes belonging to the given file.
   * Call this when a file is re-indexed to prevent stale cache hits.
   */
  invalidateFile(filePath: string): void {
    const nodesToRemove: Node[] = [];

    for (const node of this.nodeByIdCache.values()) {
      if (node.filePath === filePath) {
        nodesToRemove.push(node);
      }
    }

    for (const node of nodesToRemove) {
      // Remove from nodeByIdCache
      this.nodeByIdCache.delete(node.id);

      // Remove from nameCache
      const nameList = this.nameCache.get(node.name);
      if (nameList) {
        const filtered = nameList.filter(n => n.id !== node.id);
        if (filtered.length === 0) {
          this.nameCache.delete(node.name);
        } else {
          this.nameCache.set(node.name, filtered);
        }
      }

      // Remove from qualifiedNameCache
      if (node.qualifiedName) {
        const cached = this.qualifiedNameCache.get(node.qualifiedName);
        if (cached?.id === node.id) {
          this.qualifiedNameCache.delete(node.qualifiedName);
        }
      }

      // Remove from kindCache
      const kindList = this.kindCache.get(node.kind);
      if (kindList) {
        const filtered = kindList.filter(n => n.id !== node.id);
        if (filtered.length === 0) {
          this.kindCache.delete(node.kind);
        } else {
          this.kindCache.set(node.kind, filtered);
        }
      }

      // Remove from lowerNameCache
      const lower = node.name.toLowerCase();
      const lowerList = this.lowerNameCache.get(lower);
      if (lowerList) {
        const filtered = lowerList.filter(n => n.id !== node.id);
        if (filtered.length === 0) {
          this.lowerNameCache.delete(lower);
        } else {
          this.lowerNameCache.set(lower, filtered);
        }
      }
    }

    logDebug(`ReferenceResolver: invalidated ${nodesToRemove.length} cache entries for ${filePath}`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Resolve an import path to a node ID.
   *
   * Handles three cases:
   *  1. Relative paths (JS/TS/Go/…) — resolved via the file tree.
   *  2. Fully-qualified type imports (Java `import com.example.Foo`) — exact qualifiedName lookup,
   *     then name+namespace-prefix match.
   *  3. Namespace-level imports (C# `using MyApp.Services`) — namespace node lookup, then
   *     namespace prefix cache (O(1)) to find any class in that namespace.
   */
  private _resolveImportPath(importPath: string, sourceFilePath: string): string | null {
    // ── 1. Relative path (JS/TS etc.) ──────────────────────────────────────────
    if (importPath.startsWith('.')) {
      const sourceDir = sourceFilePath.replace(/[^/]+$/, '');
      const segments = (sourceDir + importPath).split('/');
      const normalized: string[] = [];
      for (const seg of segments) {
        if (seg === '..') normalized.pop();
        else if (seg !== '.') normalized.push(seg);
      }
      const basePath = normalized.join('/');
      const candidates = [
        basePath,
        basePath + '.ts', basePath + '.tsx',
        basePath + '.js', basePath + '.jsx',
        basePath + '/index.ts', basePath + '/index.tsx', basePath + '/index.js',
      ];
      const rawDb = (this.db as any).db;
      for (const candidate of candidates) {
        const row = rawDb.get('SELECT id FROM nodes WHERE file_path = ? LIMIT 1', [candidate]);
        if (row) return row.id;
      }
      return null;
    }

    // ── 2. Wildcard namespace import (`import com.example.*`, `using static …`) ─
    if (importPath.endsWith('.*') || importPath.endsWith('*')) {
      const ns = importPath.replace(/\.\*$/, '').replace(/\*$/, '');
      return this.namespacePrefixCache.get(ns) ?? null;
    }

    // ── 3. Exact qualifiedName match (Java `import com.example.Foo`) ───────────
    const exact = this.qualifiedNameCache.get(importPath);
    if (exact) return exact.id;

    // ── 4. Name + namespace prefix (Java: last segment is the type name) ────────
    const lastDot = importPath.lastIndexOf('.');
    if (lastDot > 0) {
      const typeName = importPath.slice(lastDot + 1);
      const namespace = importPath.slice(0, lastDot);
      const candidates = this.nameCache.get(typeName) ?? [];
      for (const candidate of candidates) {
        if (candidate.qualifiedName && candidate.qualifiedName.startsWith(namespace)) {
          return candidate.id;
        }
      }
    }

    // ── 5. Namespace-level import (C# `using MyApp.Services`) ──────────────────
    // First check for an explicit namespace node with this name
    const nsCandidates = this.nameCache.get(importPath.split('.').pop() ?? '') ?? [];
    for (const candidate of nsCandidates) {
      if (candidate.kind === 'namespace' && candidate.name === importPath) return candidate.id;
    }
    // Then fall back to the prefix cache: return any class/interface in this namespace
    return this.namespacePrefixCache.get(importPath) ?? null;
  }

  /**
   * Resolve a bare type name to a node ID.
   * Used for extends/implements refs where we have only the unqualified type name.
   * Prefers class/interface/trait/protocol nodes over other kinds.
   */
  private _resolveTypeName(name: string): string | null {
    const candidates = this.nameCache.get(name) ?? [];
    if (candidates.length > 0) {
      const preferred = candidates.find(n =>
        n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'protocol'
      );
      return (preferred ?? candidates[0]).id;
    }
    // Try as a fully-qualified name
    const qualified = this.qualifiedNameCache.get(name);
    if (qualified) return qualified.id;
    return null;
  }

  /**
   * Convert a raw DB row to a Node object.
   */
  private _rowToNode(row: any): Node {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      startColumn: row.start_column,
      endColumn: row.end_column,
      docstring: row.docstring ?? undefined,
      signature: row.signature ?? undefined,
      visibility: row.visibility ?? undefined,
      isExported: row.is_exported === 1,
      isAsync: row.is_async === 1,
      isStatic: row.is_static === 1,
      isAbstract: row.is_abstract === 1,
      decorators: row.decorators ? JSON.parse(row.decorators) : undefined,
      typeParameters: row.type_parameters ? JSON.parse(row.type_parameters) : undefined,
      updatedAt: row.updated_at,
    };
  }

  // ── Bridge Resolution ──────────────────────────────────────────────────────

  /**
   * Run cross-language bridge resolvers to synthesize edges between
   * symbols in different languages (Swift ↔ ObjC, JS ↔ Native, etc.).
   */
  private _runBridgeResolvers(): BridgeResolutionResult {
    const context = this._buildBridgeContext();
    return runBridgeResolvers(context, this.db);
  }

  /**
   * Build a ResolutionContext for bridge resolvers using the warm caches.
   */
  private _buildBridgeContext(): import('../frameworks/types').ResolutionContext {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const projectRoot = this.projectRoot;
    const db = this.db;
    const nameCache = this.nameCache;
    const kindCache = this.kindCache;
    const fileCache = new Map<string, string | null>();

    return {
      getNodesInFile(filePath: string): Node[] {
        return db.getNodesByFile(filePath);
      },
      getNodesByName(name: string): Node[] {
        return nameCache.get(name) ?? [];
      },
      getNodesByKind(kind: Node['kind']): Node[] {
        return kindCache.get(kind) ?? [];
      },
      fileExists(filePath: string): boolean {
        return fs.existsSync(path.join(projectRoot, filePath));
      },
      readFile(filePath: string): string | null {
        if (fileCache.has(filePath)) return fileCache.get(filePath)!;
        try {
          const content = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
          fileCache.set(filePath, content);
          return content;
        } catch {
          fileCache.set(filePath, null);
          return null;
        }
      },
      getProjectRoot(): string {
        return projectRoot;
      },
      getAllFiles(): string[] {
        return db.getAllFiles().map((f: any) => f.path);
      },
    };
  }
}
