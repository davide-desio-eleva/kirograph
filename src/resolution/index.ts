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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolutionResult {
  resolved: number;
  unresolved: number;
  total: number;
  durationMs: number;
}

// ── ReferenceResolver ─────────────────────────────────────────────────────────

export class ReferenceResolver {
  private db: GraphDatabase;
  private config: KiroGraphConfig;

  // Warm caches for O(1) lookup
  private nameCache: Map<string, Node[]> = new Map();
  private qualifiedNameCache: Map<string, Node> = new Map();
  private kindCache: Map<NodeKind, Node[]> = new Map();
  private lowerNameCache: Map<string, Node[]> = new Map();
  private nodeByIdCache: Map<string, Node> = new Map();

  private cacheWarmed = false;

  constructor(db: GraphDatabase, config: KiroGraphConfig) {
    this.db = db;
    this.config = config;
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

    this.cacheWarmed = true;
    logDebug(`ReferenceResolver: warmed caches with ${rows.length} nodes`);
  }

  /**
   * Resolve all pending unresolved references.
   * Warms caches first, then processes all pending refs.
   * Returns a ResolutionResult with counts and duration.
   */
  async resolveAll(): Promise<ResolutionResult> {
    const start = Date.now();

    this.warmCaches();
    const resolvedCount = await this.resolveUnresolvedRefs();

    // Count remaining unresolved
    const rawDb = (this.db as any).db;
    const remaining = rawDb.get('SELECT COUNT(*) as c FROM unresolved_refs')?.c ?? 0;
    const total = resolvedCount + remaining;

    const durationMs = Date.now() - start;
    logDebug(`ReferenceResolver: resolved ${resolvedCount}/${total} refs in ${durationMs}ms`);

    return {
      resolved: resolvedCount,
      unresolved: remaining,
      total,
      durationMs,
    };
  }

  /**
   * Process all pending unresolved references using warm caches.
   * Returns the count of newly resolved edges.
   */
  async resolveUnresolvedRefs(): Promise<number> {
    if (!this.cacheWarmed) {
      this.warmCaches();
    }

    const rawDb = (this.db as any).db;
    const refs: any[] = rawDb.all('SELECT * FROM unresolved_refs');
    let resolved = 0;

    for (const ref of refs) {
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
        // Strategy: import-path-based resolution (confidence 1.0)
        attemptedStrategies.push('import-path');
        targetId = this._resolveImportPath(refName, filePath);
      } else {
        // Strategy 1: Framework-specific (placeholder — not yet implemented)
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

          // If still not found, try matchReference across all cached nodes
          if (!targetId) {
            const allCandidates = [...this.nodeByIdCache.values()];
            const match = matchReference(refName, allCandidates, threshold);
            if (match) {
              targetId = match.nodeId;
            }
          }
        }
      }

      if (targetId) {
        // Insert resolved edge
        const edge: Edge = {
          source: sourceId,
          target: targetId,
          kind: refKind === 'import' ? 'imports' : 'calls',
          line: line ?? undefined,
          column: column ?? undefined,
        };
        this.db.insertEdge(edge);
        rawDb.run('DELETE FROM unresolved_refs WHERE id = ?', [refId]);
        resolved++;
      } else {
        // Record attempted strategies on failure
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
   * Resolve a relative import path to the ID of the first node in the target file.
   * Returns null if no indexed file matches.
   */
  private _resolveImportPath(importPath: string, sourceFilePath: string): string | null {
    if (!importPath.startsWith('.')) return null;

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
      basePath + '.ts',
      basePath + '.tsx',
      basePath + '.js',
      basePath + '.jsx',
      basePath + '/index.ts',
      basePath + '/index.tsx',
      basePath + '/index.js',
    ];

    const rawDb = (this.db as any).db;
    for (const candidate of candidates) {
      const row = rawDb.get('SELECT id FROM nodes WHERE file_path = ? LIMIT 1', [candidate]);
      if (row) return row.id;
    }

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
}
