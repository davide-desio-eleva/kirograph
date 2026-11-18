/**
 * KiroGraph Reference Resolver
 *
 * Implements the warm-cache resolution engine with multiple strategies.
 * Mirrors CodeGraph src/resolution/index.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node, NodeKind, Edge } from '../types';
import type { GraphDatabase } from '../db/database';
import type { KiroGraphConfig } from '../config';
import { resolveCall, isCallTarget, type CallContext } from './call-resolver';
import { ImportResolver } from './import-resolver';

const SUPERTYPE_KINDS = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol', 'component', 'type_alias']);
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
  /** The caches hold whole nodes (false: only what resolution reads, see warmCaches). */
  private cacheFull = false;

  constructor(db: GraphDatabase, config: KiroGraphConfig, projectRoot?: string) {
    this.db = db;
    this.config = config;
    this.projectRoot = projectRoot ?? '';
  }

  /**
   * Pre-load all nodes into Maps for O(1) lookup.
   * Must be called before resolveUnresolvedRefs() for best performance.
   *
   * With `full` false, each node holds only what resolution reads (id, kind, name, qualified
   * name, file): reading every column of every node was most of the time a resolution took. The
   * bridge resolvers need whole nodes and load them when they first ask (see _buildBridgeContext).
   */
  warmCaches(full = true): void {
    this.pythonModules = null;
    this.importResolverOf = null;
    this.fileNodes = null;
    this.cIncludeGraph = null;
    this.nameCache.clear();
    this.qualifiedNameCache.clear();
    this.kindCache.clear();
    this.lowerNameCache.clear();
    this.nodeByIdCache.clear();
    this.namespacePrefixCache.clear();

    // Access the underlying db instance to query all nodes
    const rawDb = (this.db as any).db;
    // Every column but the docstring, which nothing in resolution reads and which is a third of
    // the bytes of the table
    const rows: any[] = full
      ? rawDb.all(
        `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column,
                end_column, signature, visibility, is_exported, is_async, is_static, is_abstract,
                decorators, type_parameters, return_type, updated_at FROM nodes`)
      : rawDb.all('SELECT id, kind, name, qualified_name, file_path, language, start_line, return_type FROM nodes');

    for (const row of rows) {
      const node: Node = full
        ? this._rowToNode(row)
        : { id: row.id, kind: row.kind, name: row.name, qualifiedName: row.qualified_name, filePath: row.file_path, language: row.language, startLine: row.start_line, returnType: row.return_type ?? undefined } as Node;

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
    this.cacheFull = full;
    logDebug(`ReferenceResolver: warmed caches with ${rows.length} nodes${full ? '' : ' (resolution fields)'}`);
  }

  /**
   * Resolve all pending unresolved references.
   * Warms caches first, then processes all pending refs.
   * Returns a ResolutionResult with counts and duration.
   */
  async resolveAll(
    onProgress?: (current: number, total: number) => void,
    /** The files a sync changed. Without it (an index) everything runs. */
    changedFiles?: string[],
  ): Promise<ResolutionResult> {
    const start = Date.now();

    this.warmCaches(false);
    const resolvedCount = await this.resolveUnresolvedRefs(onProgress);

    // Count remaining unresolved
    const rawDb = (this.db as any).db;
    const remaining = rawDb.get('SELECT COUNT(*) as c FROM unresolved_refs')?.c ?? 0;
    const total = resolvedCount + remaining;

    this.applyRoutePrefixes();

    // Run cross-language bridge resolvers after standard resolution
    let bridgeResult: BridgeResolutionResult | undefined;
    // The bridges read only the file types below (and package.json to decide whether they apply),
    // and the edges they made survive a sync that touched none of those
    if (this.projectRoot && (!changedFiles || changedFiles.some(f => BRIDGE_FILE.test(f)))) {
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
    // Imports first, then supertypes: a call prefers the functions of the files its file imports,
    // and looks a method up in the supertypes of the receiver's type
    const refs: any[] = rawDb.all(`SELECT * FROM unresolved_refs ORDER BY
      CASE ref_kind WHEN 'import' THEN 0 WHEN 'extends' THEN 1 WHEN 'implements' THEN 1 ELSE 2 END, id`);
    const calls = this.callContext();
    let resolved = 0;
    const total = refs.length;

    // Process in batched transactions to avoid WASM heap exhaustion.
    // Without batching, each individual write allocates journal pages in the
    // WASM linear memory, which can exceed the 2GB limit on large codebases.
    const BATCH_SIZE = 1000;

    for (let batchStart = 0; batchStart < refs.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, refs.length);

      // Edges to add, refs to delete, and strategy lists to record are collected and written at
      // the end of the batch, in a few statements instead of one per reference.
      const batchEdges: Edge[] = [];
      const resolvedIds: number[] = [];
      const strategiesToRecord = new Map<string, number[]>(); // strategies JSON -> ref ids

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
            metadata: refMetadata,
          } = ref;

          const attemptedStrategies: string[] = [];
          let targetId: string | null = null;
          let extraTargets: string[] = [];

          if (refKind === 'reference' || refKind === 'qualified_call') {
            // Infrastructure references (infra.ts): the exact qualified name, nothing looser
            attemptedStrategies.push('qualified');
            targetId = this.qualifiedNameCache.get(refName)?.id ?? null;
          } else if (refKind === 'import') {
            attemptedStrategies.push('import-path');
            if (C_FAMILY_FILE.test(filePath)) {
              // `#include "jv.h"`: the header's file. A header with no symbol of its own (only
              // prototypes) has no node to point at: its include stays a reference, and the
              // include graph the call resolver reads has it anyway
              targetId = this.cIncludes().nodeIn(this.cIncludes().resolve(refName, filePath));
            } else if (!filePath.endsWith('.py') && this.importResolver().handles(filePath)) {
              // Java / Kotlin / Scala packages, C# namespaces, Go modules, Rust crates, PHP PSR-4,
              // JS / TS paths and workspace packages, … (see import-resolver)
              const lang = this.nodeByIdCache.get(sourceId)?.language ?? '';
              const targets = this.importResolver().resolve(refName, filePath, lang)
                .map(f => this.importTargetIn(f)).filter((id): id is string => !!id);
              targetId = targets[0] ?? null;
              extraTargets = targets.slice(1);
            } else if (filePath.endsWith('.py')) {
              // A module, and the submodules among the names it imports (`from django.db import models`)
              const targets = this._resolvePythonImport(refName, filePath, refMetadata ? JSON.parse(refMetadata).names : undefined);
              targetId = targets[0] ?? null;
              extraTargets = targets.slice(1);
            } else {
              targetId = this._resolveImportPath(refName, filePath);
            }
          } else if (refKind === 'extends' || refKind === 'implements') {
            attemptedStrategies.push('type-name');
            targetId = this._resolveSupertype(refName, sourceId, filePath, calls);
          } else {
            attemptedStrategies.push('framework');

            // Qualified name match (confidence 0.95)
            attemptedStrategies.push('qualified');
            const qualifiedNode = this.qualifiedNameCache.get(refName);
            if (qualifiedNode) {
              targetId = qualifiedNode.id;
            }

            // By name, with the receiver the call is made on (see call-resolver)
            if (!targetId) {
              const meta = refMetadata ? JSON.parse(refMetadata) : undefined;
              const dot = refName.lastIndexOf('.');
              const name = dot > 0 ? refName.slice(dot + 1) : refName;
              const receiver: string | undefined = meta?.receiver ?? (dot > 0 ? refName.slice(0, dot) : undefined);
              const call = { name, receiver, receiverType: meta?.receiverType as string | undefined, receiverCall: meta?.receiverCall, sourceId, filePath };
              attemptedStrategies.push(receiver !== undefined ? 'method' : 'exact');
              targetId = resolveCall(call, calls)?.id ?? null;

              // Case-insensitive, for the languages whose names are (only when no node has the exact name)
              const threshold = this.config.fuzzyResolutionThreshold ?? 0.5;
              if (!targetId && threshold <= 0.5 && !this.nameCache.has(name)) {
                attemptedStrategies.push('fuzzy');
                targetId = resolveCall(call, { ...calls, byName: n => this.lowerNameCache.get(n.toLowerCase()) ?? [] })?.id ?? null;
              }
            }
          }

          if (targetId) {
            const edgeKind = refKind === 'reference' ? 'references'
              : refKind === 'import' ? 'imports'
              : refKind === 'extends' ? 'extends'
              : refKind === 'implements' ? 'implements'
              : 'calls';
            const edge: Edge = {
              source: sourceId,
              target: targetId,
              kind: edgeKind,
              line: line ?? undefined,
              column: column ?? undefined,
              // The receiver stays: a sync turns the edge back into this reference (#101)
              metadata: refMetadata ? JSON.parse(refMetadata) : undefined,
            };
            batchEdges.push(edge);
            for (const extra of extraTargets) {
              batchEdges.push({ ...edge, target: extra });
              calls.addImport(filePath, extra);
            }
            resolvedIds.push(refId);
            if (edgeKind === 'imports') calls.addImport(filePath, targetId);
            if (edgeKind === 'extends' || edgeKind === 'implements') calls.addSupertype(sourceId, targetId);
            resolved++;
          } else {
            // Nothing to write when the same list is already recorded: a reference that stays
            // unresolved is tried again on every resolution and ends up with the same list.
            const strategiesJson = JSON.stringify(attemptedStrategies);
            if (ref.attempted_strategies !== strategiesJson) {
              const ids = strategiesToRecord.get(strategiesJson);
              if (ids) ids.push(refId); else strategiesToRecord.set(strategiesJson, [refId]);
            }
          }
        }
        this.db.insertEdges(batchEdges);
        for (const group of idGroups(resolvedIds)) {
          rawDb.run(`DELETE FROM unresolved_refs WHERE id IN (${group.map(() => '?').join(',')})`, group);
        }
        for (const [strategiesJson, ids] of strategiesToRecord) {
          for (const group of idGroups(ids)) {
            rawDb.run(
              `UPDATE unresolved_refs SET attempted_strategies = ? WHERE id IN (${group.map(() => '?').join(',')})`,
              [strategiesJson, ...group],
            );
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
  /**
   * Apply `register(target, { prefix })` mounts so each route reads as its full path
   * (`GET /api/v1/users/:id`), including through nested plugins.
   *
   * Model: a mount's target is a scope (a plugin declaration, an inline plugin function, or the
   * whole file when the plugin cannot be matched by name). A scope's absolute prefix is its
   * owner's absolute prefix plus the prefix of the mount that targets it. A route takes the
   * prefix of the innermost mounted scope that contains it.
   *
   * Raw paths are kept in qualified_name and names are recomputed on every pass, so a removed
   * mount or a re-indexed plugin file cannot leave a stale prefix behind.
   */
  private applyRoutePrefixes(): void {
    const rawDb = (this.db as any).db;
    const mounts: RouteMountRow[] = rawDb.all(
      'SELECT id, file_path, plugin_name, imported_name, specifier, prefix, line, inline_start, inline_end FROM route_mounts ORDER BY id',
    );

    const declCache = new Map<string, DeclRow[]>();
    const declsOf = (file: string): DeclRow[] => {
      let decls = declCache.get(file);
      if (!decls) {
        decls = rawDb.all(
          "SELECT name, start_line, end_line FROM nodes WHERE file_path = ? AND kind IN ('function', 'method', 'constant')",
          [file],
        );
        declCache.set(file, decls!);
      }
      return decls!;
    };

    // Each mount targets one scope. The first mount that targets a scope is the one that counts.
    const targetOf = new Map<number, RouteScope>();
    const mountOfScope = new Map<string, RouteMountRow>();
    const scopeByKey = new Map<string, RouteScope>();
    for (const m of mounts) {
      const target = this._mountTarget(m, declsOf);
      if (!target) continue;
      targetOf.set(m.id, target);
      if (!mountOfScope.has(target.key)) {
        mountOfScope.set(target.key, m);
        scopeByKey.set(target.key, target);
      }
    }

    // Owner of a mount: the innermost scope in its file that contains the register call. A
    // mount never owns itself, which matters for an inline plugin registered on its own line.
    const ownerOf = (m: RouteMountRow): string => {
      const own = targetOf.get(m.id)?.key;
      const candidates: RouteScope[] = [
        ...mounts
          .filter(x => x.file_path === m.file_path && x.inline_start != null)
          .map(x => ({ key: `${x.file_path}@${x.inline_start}`, file: x.file_path, start: x.inline_start!, end: x.inline_end! })),
        ...declsOf(m.file_path).map(d => ({
          key: `${m.file_path}#${d.name}@${d.start_line}`, file: m.file_path, start: d.start_line, end: d.end_line,
        })),
      ];
      let best: RouteScope | null = null;
      for (const c of candidates) {
        if (c.key === own || m.line < c.start || m.line > c.end) continue;
        if (!best || c.end - c.start < best.end - best.start) best = c;
      }
      return best ? best.key : wholeFileKey(m.file_path);
    };

    const memo = new Map<string, string>();
    const absolutePrefix = (key: string, depth = 0): string => {
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const mount = mountOfScope.get(key);
      if (!mount || depth > 32) return '';
      const value = joinPrefix(absolutePrefix(ownerOf(mount), depth + 1), mount.prefix);
      memo.set(key, value);
      return value;
    };

    // Innermost mounted scope containing each route
    const mountedScopes = [...scopeByKey.values()];

    const routes: Array<{ id: string; name: string; file_path: string; qualified_name: string; start_line: number }> =
      rawDb.all("SELECT id, name, file_path, qualified_name, start_line FROM nodes WHERE kind = 'route'");
    for (const r of routes) {
      const match = /::([A-Z]+):(.*)$/.exec(r.qualified_name);
      if (!match) continue;
      const [, method, rawPath] = match;
      let scope: RouteScope | null = null;
      for (const s of mountedScopes) {
        if (s.file !== r.file_path || r.start_line < s.start || r.start_line > s.end) continue;
        if (!scope || s.end - s.start < scope.end - scope.start) scope = s;
      }
      const prefix = scope ? absolutePrefix(scope.key) : '';
      const name = `${method} ${fullRoutePath(prefix, rawPath!)}`;
      if (name !== r.name) rawDb.run('UPDATE nodes SET name = ? WHERE id = ?', [name, r.id]);
    }
  }

  /**
   * The scope a mount targets. An inline plugin is its own function span; a named plugin is its
   * declaration in the target module, matched by export name; otherwise the whole target file.
   */
  private _mountTarget(m: RouteMountRow, declsOf: (file: string) => DeclRow[]): RouteScope | null {
    if (m.inline_start != null) {
      return { key: `${m.file_path}@${m.inline_start}`, file: m.file_path, start: m.inline_start, end: m.inline_end! };
    }
    const file = m.specifier ? this._resolveModuleFile(m.specifier, m.file_path) : m.file_path;
    if (!file) return null;
    const name = m.imported_name ?? m.plugin_name;
    const decl = declsOf(file).find(d => d.name === name);
    if (decl) {
      return { key: `${file}#${decl.name}@${decl.start_line}`, file, start: decl.start_line, end: decl.end_line };
    }
    return { key: wholeFileKey(file), file, start: 0, end: Number.MAX_SAFE_INTEGER };
  }

  /** File path of a relative module specifier, or null. Package imports are not project files. */
  private _resolveModuleFile(specifier: string, fromFile: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const sourceDir = fromFile.replace(/[^/]+$/, '');
    const normalized: string[] = [];
    for (const seg of (sourceDir + specifier).split('/')) {
      if (seg === '..') normalized.pop();
      else if (seg !== '.') normalized.push(seg);
    }
    const base = normalized.join('/');
    const rawDb = (this.db as any).db;
    for (const candidate of [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx',
      base + '/index.ts', base + '/index.tsx', base + '/index.js']) {
      const row = rawDb.get('SELECT path FROM files WHERE path = ?', [candidate]);
      if (row) return row.path;
    }
    return null;
  }

  /** The import resolver of this pass, and a node of each file for an import edge to point at. */
  private importResolverOf: ImportResolver | null = null;
  private fileNodes: Map<string, Node[]> | null = null;

  private importResolver(): ImportResolver {
    if (!this.importResolverOf) {
      const rawDb = (this.db as any).db;
      const files = (rawDb.all('SELECT path FROM files') as any[]).map(r => String(r.path));
      const byFile = new Map<string, Node[]>();
      for (const n of this.nodeByIdCache.values()) {
        const list = byFile.get(n.filePath);
        if (list) list.push(n); else byFile.set(n.filePath, [n]);
      }
      this.fileNodes = byFile;
      this.importResolverOf = new ImportResolver(this.projectRoot, files, f => byFile.get(f) ?? []);
    }
    return this.importResolverOf;
  }

  /** The node an import of a file points at: a declaration of it, else any of its nodes. */
  private importTargetIn(file: string): string | null {
    const nodes = this.fileNodes?.get(file) ?? [];
    return (nodes.find(n => n.kind !== 'import') ?? nodes[0])?.id ?? null;
  }

  /** The C / C++ include graph of this pass (see cIncludes). */
  private cIncludeGraph: CIncludeGraph | null = null;

  /**
   * The project's C / C++ include graph: what each file's `#include`s resolve to (from the include
   * nodes and the files table, which lists headers with no symbol too), the files a file reaches
   * through them, and whether one of those headers declares a name. `#include "x.h"` is looked
   * for next to the including file, then as a path suffix (`fmt/format.h` →
   * `include/fmt/format.h`); a system header (`<string.h>`) is not a project file.
   */
  private cIncludes(): CIncludeGraph {
    if (this.cIncludeGraph) return this.cIncludeGraph;
    const rawDb = (this.db as any).db;
    const files: string[] = (rawDb.all('SELECT path FROM files') as any[]).map(r => String(r.path)).filter(f => C_FAMILY_FILE.test(f));
    const fileSet = new Set(files);
    const bySuffix = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('/');
        const list = bySuffix.get(key);
        if (list) list.push(f); else bySuffix.set(key, [f]);
      }
    }
    const nodeOf = new Map<string, string>();
    const includesOf = new Map<string, string[]>();
    for (const n of this.nodeByIdCache.values()) {
      if (!C_FAMILY_FILE.test(n.filePath)) continue;
      if (n.kind === 'import') {
        const list = includesOf.get(n.filePath);
        if (list) list.push(n.name); else includesOf.set(n.filePath, [n.name]);
      } else if (!nodeOf.has(n.filePath)) {
        nodeOf.set(n.filePath, n.id);
      }
    }
    const resolve = (include: string, from: string): string | undefined => {
      const dir = from.split('/').slice(0, -1);
      const joined: string[] = [];
      for (const seg of [...dir, ...include.split('/')]) {
        if (seg === '..') joined.pop(); else if (seg !== '.' && seg !== '') joined.push(seg);
      }
      const local = joined.join('/');
      if (fileSet.has(local)) return local;
      const found = bySuffix.get(include.replace(/^(\.\.?\/)+/, ''));
      if (!found || found.length === 0) return undefined;
      // Several files with the path: the one nearest the including file
      const shared = (f: string) => { let i = 0; while (i < f.length && f[i] === from[i]) i++; return i; };
      return found.reduce((a, b) => (shared(b) > shared(a) ? b : a));
    };
    const direct = new Map<string, string[]>();
    for (const [file, includes] of includesOf) {
      direct.set(file, includes.map(i => resolve(i, file)).filter((f): f is string => !!f && f !== file));
    }
    const closures = new Map<string, Set<string>>();
    const reach = (file: string): Set<string> => {
      const cached = closures.get(file);
      if (cached) return cached;
      const seen = new Set<string>();
      const stack = [...(direct.get(file) ?? [])];
      while (stack.length > 0) {
        const f = stack.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        stack.push(...(direct.get(f) ?? []));
      }
      closures.set(file, seen);
      return seen;
    };
    // A source another file includes (decNumber's decBasic.c, in decDouble.c and decQuad.c) is
    // compiled as part of it: it sees what its includers see. Not a header, which is included
    // nearly everywhere and would see the whole project
    const includers = new Map<string, string[]>();
    for (const [file, targets] of direct) {
      for (const target of targets) {
        const list = includers.get(target);
        if (list) list.push(file); else includers.set(target, [file]);
      }
    }
    const visibleCache = new Map<string, Set<string>>();
    const visible = (file: string): Set<string> => {
      const cached = visibleCache.get(file);
      if (cached) return cached;
      const out = new Set(reach(file));
      const queue = C_HEADER_FILE.test(file) ? [] : [...(includers.get(file) ?? [])];
      const seen = new Set<string>([file]);
      while (queue.length > 0) {
        const g = queue.shift()!;
        if (seen.has(g)) continue;
        seen.add(g);
        out.add(g);
        for (const f of reach(g)) out.add(f);
        if (!C_HEADER_FILE.test(g)) queue.push(...(includers.get(g) ?? []));
      }
      out.delete(file);
      visibleCache.set(file, out);
      return out;
    };
    const texts = new Map<string, string>();
    const textOf = (f: string): string => {
      let text = texts.get(f);
      if (text === undefined) {
        try { text = fs.readFileSync(path.join(this.projectRoot, f), 'utf8'); } catch { text = ''; }
        texts.set(f, text);
      }
      return text;
    };
    const declared = new Map<string, boolean>();
    this.cIncludeGraph = {
      resolve,
      nodeIn: f => (f ? nodeOf.get(f) ?? null : null),
      reach: visible,
      declares: (from, name) => {
        const key = from + '\0' + name;
        let yes = declared.get(key);
        if (yes === undefined) {
          const id = name.replace(/[^\w~]/g, '');
          const re = new RegExp(`\\b${id}\\s*\\(`);
          yes = declaresItself(textOf(from), id) || [...visible(from)].some(h => C_HEADER_FILE.test(h) &&
            (re.test(textOf(h)) || re.test(expandPastingMacros(textOf(h)))));
          declared.set(key, yes);
        }
        return yes;
      },
    };
    return this.cIncludeGraph;
  }

  /** Python modules by every dotted suffix of their path (`db.models`, `django.db.models`), and a node of each file. */
  private pythonModules: { byKey: Map<string, string[]>; nodeOf: Map<string, string> } | null = null;

  /**
   * The files a Python import names: the module (`from .base import x`, `import django.db`), and
   * those of the imported names that are submodules (`from django.db import models`). As node ids
   * of those files, the module first. A module outside the project resolves to nothing.
   */
  private _resolvePythonImport(module: string, sourceFilePath: string, names?: string[]): string[] {
    if (!this.pythonModules) {
      const byKey = new Map<string, string[]>();
      const nodeOf = new Map<string, string>();
      // A folder with an __init__.py is a package: a module path starts at a folder that is not
      // one (the project root, `src/`), so `import copy` is the standard library's, not django/utils/copy.py
      const rawDb = (this.db as any).db;
      const packages = new Set<string>(
        (rawDb.all(`SELECT path FROM files WHERE path LIKE '%__init__.py'`) as any[])
          .map(r => String(r.path).replace(/\/?__init__\.py$/, '')));
      for (const n of this.nodeByIdCache.values()) {
        if (!n.filePath.endsWith('.py') || nodeOf.has(n.filePath)) continue;
        nodeOf.set(n.filePath, n.id);
        const parts = n.filePath.replace(/\.py$/, '').replace(/(^|\/)__init__$/, '').split('/').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0 && packages.has(parts.slice(0, i).join('/'))) continue;
          const key = parts.slice(i).join('.');
          const list = byKey.get(key);
          if (list) list.push(n.filePath); else byKey.set(key, [n.filePath]);
        }
      }
      this.pythonModules = { byKey, nodeOf };
    }
    const { byKey, nodeOf } = this.pythonModules;
    const fileOf = (mod: string): string | undefined => {
      const dots = /^\.*/.exec(mod)![0].length;
      if (dots === 0) {
        // The shortest path that ends with the module: `django/db/models/__init__.py` for django.db.models
        return byKey.get(mod)?.reduce((a, b) => (a.length <= b.length ? a : b));
      }
      const dir = sourceFilePath.split('/').slice(0, -1);
      const base = dir.slice(0, Math.max(0, dir.length - (dots - 1))).join('/');
      const rel = mod.slice(dots).replace(/\./g, '/');
      const prefix = base ? base + '/' : '';
      const candidates = rel ? [`${prefix}${rel}.py`, `${prefix}${rel}/__init__.py`] : [`${prefix}__init__.py`];
      return candidates.find(f => nodeOf.has(f));
    };
    const files: string[] = [];
    const add = (f: string | undefined) => { if (f && !files.includes(f)) files.push(f); };
    add(fileOf(module));
    for (const name of names ?? []) add(fileOf(module.endsWith('.') ? module + name : `${module}.${name}`));
    return files.filter(f => f !== sourceFilePath).map(f => nodeOf.get(f)!);
  }

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
   * What the call resolver reads: nodes by name and id, the files each file imports (the import
   * edges already in the graph, and those this pass makes), and each node's owner.
   */
  private callContext(): CallContext & { addImport(filePath: string, targetId: string): void; addSupertype(id: string, superId: string): void } {
    const rawDb = (this.db as any).db;
    const imports = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      if (from === to) return;
      let set = imports.get(from);
      if (!set) imports.set(from, (set = new Set()));
      set.add(to);
    };
    for (const r of rawDb.all(`
      SELECT s.file_path AS f, t.file_path AS t FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'imports'`) as any[]) add(r.f, r.t);
    let owners: Map<string, { id: string; name: string; kind: string }> | null = null;
    const supers = new Map<string, string[]>();
    const addSuper = (id: string, s: string) => {
      const list = supers.get(id);
      if (!list) supers.set(id, [s]); else if (!list.includes(s)) list.push(s);
    };
    for (const r of rawDb.all(`SELECT source, target FROM edges WHERE kind IN ('extends', 'implements')`) as any[]) addSuper(r.source, r.target);
    return {
      byName: name => this.nameCache.get(name) ?? [],
      node: id => this.nodeByIdCache.get(id),
      importedFiles: filePath => {
        // What the file imports, and what the package files among those re-export
        // (`__init__.py`, `index.ts`): `from django.template import Template` reaches template/base.py
        const direct = imports.get(filePath);
        if (!direct) return undefined;
        const all = new Set(direct);
        const queue = [...direct].map(f => ({ f, depth: 1 }));
        while (queue.length > 0) {
          const { f, depth } = queue.shift()!;
          if (depth > 3 || !BARREL_FILE.test(f)) continue;
          for (const next of imports.get(f) ?? []) {
            if (!all.has(next)) { all.add(next); queue.push({ f: next, depth: depth + 1 }); }
          }
        }
        return all;
      },
      owner: id => {
        if (!owners) {
          owners = new Map();
          for (const r of rawDb.all(`
            SELECT e.target AS id, s.id AS owner, s.name AS name, s.kind AS kind FROM edges e JOIN nodes s ON s.id = e.source
            WHERE e.kind = 'contains' AND s.kind IN ('class', 'struct', 'interface', 'trait', 'protocol',
              'module', 'namespace', 'component', 'enum')`) as any[]) owners.set(r.id, { id: r.owner, name: r.name, kind: r.kind });
        }
        return owners.get(id);
      },
      supertypes: id => supers.get(id) ?? [],
      cVisible: (filePath, candidate) => {
        if (!C_FAMILY_FILE.test(filePath)) return true;
        const g = this.cIncludes();
        return g.reach(filePath).has(candidate.filePath) || g.declares(filePath, candidate.name);
      },
      addSupertype: addSuper,
      addImport: (filePath, targetId) => {
        const target = this.nodeByIdCache.get(targetId);
        if (target) add(filePath, target.filePath);
      },
    };
  }

  /**
   * The type a class extends or implements, by name: in the class's language family, in its own
   * file, else in a file it imports, else the one type of the name. Several left: none, rather than
   * a wrong supertype for the methods looked up through it.
   */
  private _resolveSupertype(name: string, sourceId: string, filePath: string, calls: CallContext): string | null {
    const source = this.nodeByIdCache.get(sourceId);
    const types = (this.nameCache.get(name) ?? []).filter(n =>
      SUPERTYPE_KINDS.has(n.kind) && n.id !== sourceId && isCallTarget(n, source?.language));
    if (types.length === 0) return null;
    const local = types.filter(n => n.filePath === filePath);
    if (local.length > 0) return local[0].id;
    const imported = calls.importedFiles(filePath);
    const fromImports = imported ? types.filter(n => imported.has(n.filePath)) : [];
    if (fromImports.length > 0) return fromImports.length === 1 ? fromImports[0].id : null;
    return types.length === 1 ? types[0].id : null;
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
      returnType: row.return_type ?? undefined,
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
    const nodeByIdCache = this.nodeByIdCache;
    const fileCache = new Map<string, string | null>();
    // Nodes by file, from the warm cache instead of one query per file: every bridge asks for the
    // nodes of every file it scans, which was 280 ms of queries on 600 files. The cache lists
    // nodes in table order, so each file's nodes come in the order the query returned them.
    let nodesByFile: Map<string, Node[]> | null = null;
    let allFiles: string[] | null = null;
    // Whole nodes are loaded the first time a bridge asks for one: resolution warms only the
    // fields it reads, and most projects have no bridge that applies (detect() reads files only)
    const ensureFull = (): void => {
      if (!this.cacheFull) this.warmCaches(true);
    };

    return {
      getNodesInFile(filePath: string): Node[] {
        ensureFull();
        if (!nodesByFile) {
          nodesByFile = new Map();
          for (const node of nodeByIdCache.values()) {
            const list = nodesByFile.get(node.filePath);
            if (list) list.push(node); else nodesByFile.set(node.filePath, [node]);
          }
        }
        return nodesByFile.get(filePath) ?? [];
      },
      getNodesByName(name: string): Node[] {
        ensureFull();
        return nameCache.get(name) ?? [];
      },
      getNodesByKind(kind: Node['kind']): Node[] {
        ensureFull();
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
        return allFiles ??= db.getAllFiles().map((f: any) => f.path);
      },
    };
  }
}

/** Files the bridge resolvers look at (see resolution/bridges). */
/** C and C++ sources and headers. */
const C_FAMILY_FILE = /\.(c|h|cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+|ipp|inl|tpp|m|mm)$/;
const C_HEADER_FILE = /\.(h|hpp|hh|hxx|h\+\+|ipp|inl|tpp)$/;

const expandedCache = new Map<string, string>();

/**
 * A header's text with its token-pasting macros expanded, for the declarations they write:
 * `#define BINOP(name) jv binop_ ## name(jv, jv);` applied by a list `BINOPS` of `BINOP(plus)`,
 * `BINOP(multiply)`, … declares `binop_multiply(`. Only macros whose body pastes (`##`), and the
 * object-like macros that apply them; arguments without parentheses. Other text is unchanged.
 */
function expandPastingMacros(text: string): string {
  const cached = expandedCache.get(text);
  if (cached !== undefined) return cached;
  let out = text;
  if (text.includes('##')) {
    const joined = text.replace(/\\\r?\n/g, ' ');
    const fns = new Map<string, { params: string[]; body: string }>();
    const objects = new Map<string, string>();
    const define = /^[ \t]*#[ \t]*define[ \t]+(\w+)(\(([^)]*)\))?[ \t]*(.*)$/gm;
    for (let m = define.exec(joined); m; m = define.exec(joined)) {
      if (m[2] !== undefined) fns.set(m[1], { params: m[3].split(',').map(s => s.trim()).filter(Boolean), body: m[4] });
      else objects.set(m[1], m[4]);
    }
    const pasting = [...fns].filter(([, f]) => f.body.includes('##')).map(([n]) => n);
    if (pasting.length > 0) {
      const lists = [...objects].filter(([, body]) => pasting.some(n => new RegExp(`\\b${n}\\s*\\(`).test(body)));
      // Text outside the directives, with the lists written out
      let body = joined.split('\n').filter(l => !/^[ \t]*#/.test(l)).join('\n');
      for (const [name, value] of lists) body = body.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
      for (const name of pasting) {
        const f = fns.get(name)!;
        body = body.replace(new RegExp(`\\b${name}\\s*\\(([^()]*)\\)`, 'g'), (_m, args: string) => {
          const values = args.split(',').map(s => s.trim());
          let r = f.body;
          f.params.forEach((p, i) => { r = r.replace(new RegExp(`\\b${p}\\b`, 'g'), values[i] ?? ''); });
          return r.replace(/\s*##\s*/g, '');
        });
      }
      out = body;
    }
  }
  expandedCache.set(text, out);
  return out;
}

/** Words a statement that calls a function can start with: not a declaration's type. */
const C_STATEMENT_WORDS = new Set(['return', 'else', 'case', 'if', 'while', 'for', 'do', 'goto', 'sizeof',
  'delete', 'new', 'throw', 'co_return', 'co_await', 'co_yield']);

/**
 * Whether a C / C++ file declares a function itself: an `extern` prototype
 * (`extern jv _jq_path_append(…);`), or a prototype line (`GTEST_API_ TestInfo* Make(…);`) — a type
 * before the name, a parameter list, a semicolon. Its own call (`x = Make(…);`) is neither.
 */
function declaresItself(text: string, id: string): boolean {
  if (new RegExp(`\\bextern\\b[^;{}]*\\b${id}\\s*\\(`).test(text)) return true;
  const proto = new RegExp(`^[ \\t]*([A-Za-z_][\\w:<>, \\t*&]*?)[ \\t*&]${id}\\s*\\([^;{}()]*(?:\\([^;{}()]*\\)[^;{}()]*)*\\)[^;{}=]*;`, 'gm');
  for (let m = proto.exec(text); m; m = proto.exec(text)) {
    const first = m[1].trim().split(/[\s*&]/)[0];
    if (!C_STATEMENT_WORDS.has(first) && !/[=(]/.test(m[1])) return true;
  }
  return false;
}

interface CIncludeGraph {
  /** The project file an `#include` names, seen from a file. */
  resolve(include: string, from: string): string | undefined;
  /** A node of the file, for an include edge to point at. */
  nodeIn(file: string | undefined): string | null;
  /**
   * The files a file sees: those it reaches through its includes, transitively, and, for a source
   * other files include, what they see.
   */
  reach(file: string): Set<string>;
  /** Whether a header the file reaches declares the name as a function (`name(`), or the file an `extern` prototype of it. */
  declares(file: string, name: string): boolean;
}

/** Files that gather and re-export a package's symbols. */
const BARREL_FILE = /(^|\/)(__init__\.py|index\.(ts|tsx|js|jsx|mjs|cjs))$/;

const BRIDGE_FILE = /(\.(tsx?|jsx?|m|mm|h|swift|java|kt|dart)|(^|\/)(package\.json|expo-module\.config\.json))$/;

/**
 * Splits ids into groups whose sizes are powers of two, for IN (...) lists. A handful of distinct
 * statements is all that is ever prepared, so they stay in the statement cache.
 */
function idGroups(ids: number[]): number[][] {
  const sizes = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
  const groups: number[][] = [];
  let i = 0;
  while (i < ids.length) {
    const size = sizes.find(n => n <= ids.length - i)!;
    groups.push(ids.slice(i, i + size));
    i += size;
  }
  return groups;
}

/** Key of the scope that stands for a whole file (a plugin the resolver could not match by name). */
function wholeFileKey(file: string): string {
  return `${file}#*`;
}

/** Absolute prefix of a scope: the owner's prefix with this mount's prefix appended. */
function joinPrefix(ownerPrefix: string, mountPrefix: string): string {
  return ownerPrefix.replace(/\/$/, '') + mountPrefix;
}

/** Full path of a route: its mount prefix followed by the path as written. */
function fullRoutePath(prefix: string, path: string): string {
  if (!prefix) return path;
  if (path === '/') return prefix.replace(/\/$/, '') || '/';
  return prefix.replace(/\/$/, '') + path;
}

interface RouteMountRow {
  id: number;
  file_path: string;
  plugin_name: string;
  imported_name: string | null;
  specifier: string | null;
  prefix: string;
  line: number;
  inline_start: number | null;
  inline_end: number | null;
}

interface DeclRow {
  name: string;
  start_line: number;
  end_line: number;
}

/** A scope of code that a mount targets: a line span in one file, identified by key. */
interface RouteScope {
  key: string;
  file: string;
  start: number;
  end: number;
}
