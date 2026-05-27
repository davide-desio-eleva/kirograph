/**
 * Execution Flow Tracing
 *
 * Traces call chains from entry points (functions with no incoming call edges,
 * route handlers, main functions) through the graph, sorted by criticality.
 */

import type { GraphDatabase } from '../db/database';

export interface FlowHop {
  symbol: string;
  kind: string;
  filePath: string;
  line: number;
  edgeKind?: string;
  confidence?: string;
}

export interface ExecutionFlow {
  entryPoint: string;
  entryPointKind: string;
  entryPointFile: string;
  criticality: number;
  hops: FlowHop[];
}

/**
 * Detect entry points: symbols that are likely execution starting points.
 * - Route nodes
 * - Functions with zero incoming call edges
 * - Symbols matching known entry patterns (main, handler, controller, etc.)
 */
export function detectEntryPoints(db: GraphDatabase, limit = 20): Array<{ id: string; name: string; kind: string; filePath: string; line: number }> {
  const rawDb = db.getRawDb();

  // 1. Route nodes are always entry points
  const routes = rawDb.all(
    `SELECT id, name, kind, file_path as filePath, start_line as line FROM nodes WHERE kind = 'route' LIMIT ?`,
    [limit]
  ) as any[];

  // 2. Functions/methods with no incoming call edges (graph roots)
  const roots = rawDb.all(
    `SELECT n.id, n.name, n.kind, n.file_path as filePath, n.start_line as line
     FROM nodes n
     WHERE n.kind IN ('function', 'method')
       AND n.is_exported = 1
       AND NOT EXISTS (
         SELECT 1 FROM edges e WHERE e.target = n.id AND e.kind = 'calls'
       )
     ORDER BY (SELECT COUNT(*) FROM edges e2 WHERE e2.source = n.id) DESC
     LIMIT ?`,
    [limit]
  ) as any[];

  // 3. Known entry point patterns
  const patterns = rawDb.all(
    `SELECT id, name, kind, file_path as filePath, start_line as line FROM nodes
     WHERE (lower(name) LIKE '%handler%' OR lower(name) LIKE '%controller%'
       OR lower(name) = 'main' OR lower(name) LIKE '%middleware%'
       OR lower(name) LIKE '%endpoint%')
       AND kind IN ('function', 'method', 'class')
     LIMIT ?`,
    [limit]
  ) as any[];

  // Deduplicate by id
  const seen = new Set<string>();
  const results: Array<{ id: string; name: string; kind: string; filePath: string; line: number }> = [];
  for (const entry of [...routes, ...roots, ...patterns]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      results.push(entry);
    }
  }

  return results.slice(0, limit);
}

/**
 * Trace a single execution flow from an entry point forward through call edges.
 * Returns the chain of hops with criticality scoring.
 */
export function traceFlow(db: GraphDatabase, entryPointId: string, maxDepth = 10): FlowHop[] {
  const rawDb = db.getRawDb();
  const hops: FlowHop[] = [];
  const visited = new Set<string>();

  function walk(nodeId: string, depth: number): void {
    if (depth >= maxDepth || visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = rawDb.get(
      'SELECT name, kind, file_path as filePath, start_line as line FROM nodes WHERE id = ?',
      [nodeId]
    ) as any;
    if (!node) return;

    const edgeInfo = depth === 0 ? undefined : rawDb.get(
      `SELECT kind, confidence FROM edges WHERE target = ? AND source IN (${[...visited].map(() => '?').join(',')}) LIMIT 1`,
      [nodeId, ...[...visited]]
    ) as any;

    hops.push({
      symbol: node.name,
      kind: node.kind,
      filePath: node.filePath,
      line: node.line,
      edgeKind: edgeInfo?.kind,
      confidence: edgeInfo?.confidence,
    });

    // Follow outgoing call edges, ordered by target's fan-out (criticality)
    const callees = rawDb.all(
      `SELECT e.target, e.kind as edgeKind, e.confidence
       FROM edges e
       WHERE e.source = ? AND e.kind = 'calls'
       ORDER BY (SELECT COUNT(*) FROM edges e2 WHERE e2.source = e.target) DESC
       LIMIT 5`,
      [nodeId]
    ) as any[];

    for (const callee of callees) {
      walk(callee.target, depth + 1);
    }
  }

  walk(entryPointId, 0);
  return hops;
}

/**
 * Compute criticality score for a flow based on:
 * - Length (longer flows = more critical paths)
 * - Fan-out of hops (more downstream = higher criticality)
 * - Whether it touches I/O-like patterns (db, http, file)
 */
export function scoreCriticality(hops: FlowHop[]): number {
  if (hops.length === 0) return 0;

  const lengthScore = Math.min(hops.length / 10, 1.0); // normalize to 0-1

  const ioPatterns = /db|database|query|http|fetch|request|file|write|read|socket|stream/i;
  const touchesIO = hops.some(h => ioPatterns.test(h.symbol));
  const ioScore = touchesIO ? 0.3 : 0;

  return Math.min(lengthScore * 0.7 + ioScore, 1.0);
}

/**
 * Get execution flows from all detected entry points.
 */
export function getExecutionFlows(db: GraphDatabase, opts?: { maxFlows?: number; maxDepth?: number }): ExecutionFlow[] {
  const maxFlows = opts?.maxFlows ?? 15;
  const maxDepth = opts?.maxDepth ?? 10;

  const entryPoints = detectEntryPoints(db, maxFlows * 2);
  const flows: ExecutionFlow[] = [];

  for (const ep of entryPoints) {
    const hops = traceFlow(db, ep.id, maxDepth);
    if (hops.length < 2) continue; // Skip trivial flows (single node)

    const criticality = scoreCriticality(hops);
    flows.push({
      entryPoint: ep.name,
      entryPointKind: ep.kind,
      entryPointFile: ep.filePath,
      criticality,
      hops,
    });
  }

  // Sort by criticality descending
  flows.sort((a, b) => b.criticality - a.criticality);
  return flows.slice(0, maxFlows);
}
