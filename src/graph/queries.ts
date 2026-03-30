/**
 * KiroGraph Graph Query Manager
 * High-level graph queries built on top of GraphTraverser and GraphDatabase.
 */

import type { Node, NodeContext, NodeMetrics, Subgraph } from '../types';
import type { GraphDatabase } from '../db/database';
import { GraphTraverser, type TraversalOptions } from './traversal';

export class GraphQueryManager {
  private readonly traverser: GraphTraverser;

  constructor(private readonly db: GraphDatabase) {
    this.traverser = new GraphTraverser(db);
  }

  /** Get full context for a node (node + ancestors + children + callers + callees). */
  async getContext(nodeId: string): Promise<NodeContext> {
    const ctx = this.db.getNodeContext(nodeId);
    if (!ctx) {
      const node = this.db.getNode(nodeId);
      if (!node) throw new Error(`Node not found: ${nodeId}`);
      return { node, ancestors: [], children: [], callers: [], callees: [] };
    }
    return ctx;
  }

  /** Get all nodes that call the given node (depth=1, incoming 'calls' edges). */
  async getCallers(nodeId: string, limit?: number): Promise<Node[]> {
    return this.traverser.traverseBFS(nodeId, {
      direction: 'incoming',
      edgeKinds: ['calls'],
      maxDepth: 1,
      limit,
    });
  }

  /** Get all nodes called by the given node (depth=1, outgoing 'calls' edges). */
  async getCallees(nodeId: string, limit?: number): Promise<Node[]> {
    return this.traverser.traverseBFS(nodeId, {
      direction: 'outgoing',
      edgeKinds: ['calls'],
      maxDepth: 1,
      limit,
    });
  }

  /** Get the full call graph rooted at nodeId up to the given depth. */
  async getCallGraph(nodeId: string, depth = 3): Promise<Subgraph> {
    const nodes = await this.traverser.traverseBFS(nodeId, {
      direction: 'outgoing',
      edgeKinds: ['calls'],
      maxDepth: depth,
      includeStart: true,
    });
    const nodeIds = nodes.map(n => n.id);
    const edges = this.db.getEdgesForNodes(nodeIds).filter(
      e => nodeIds.includes(e.source) && nodeIds.includes(e.target) && e.kind === 'calls'
    );
    return { nodes, edges, entryPoints: [nodeId] };
  }

  /**
   * Get the type hierarchy for a node.
   * direction: 'up' = base types, 'down' = derived types, 'both' = all.
   */
  async getTypeHierarchy(nodeId: string, direction: 'up' | 'down' | 'both' = 'both'): Promise<Node[]> {
    const traversalDirection =
      direction === 'up' ? 'outgoing' :
      direction === 'down' ? 'incoming' :
      'both';

    return this.traverser.traverseBFS(nodeId, {
      direction: traversalDirection,
      edgeKinds: ['extends', 'implements'],
    });
  }

  /** Get all nodes that would be impacted by changing nodeId (incoming edges). */
  async getImpactRadius(nodeId: string, depth = 2): Promise<Node[]> {
    return this.traverser.traverseBFS(nodeId, {
      direction: 'incoming',
      maxDepth: depth,
    });
  }

  /** Find the shortest path between two nodes via BFS. */
  async findPath(fromId: string, toId: string, maxDepth = 10): Promise<Node[]> {
    if (fromId === toId) {
      const node = this.db.getNode(fromId);
      return node ? [node] : [];
    }

    const prev = new Map<string, string>();
    const queue: Array<[string, number]> = [[fromId, 0]];
    const visited = new Set<string>([fromId]);
    let found = false;

    outer: while (queue.length > 0) {
      const [currentId, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;

      const edges = this.db.getEdgesForNodes([currentId]).filter(e => e.source === currentId);
      for (const edge of edges) {
        const neighborId = edge.target;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          prev.set(neighborId, currentId);
          if (neighborId === toId) {
            found = true;
            break outer;
          }
          queue.push([neighborId, depth + 1]);
        }
      }
    }

    if (!found) return [];

    // Reconstruct path
    const pathIds: string[] = [];
    let cur: string | undefined = toId;
    while (cur !== undefined) {
      pathIds.unshift(cur);
      cur = prev.get(cur);
    }

    const result: Node[] = [];
    for (const id of pathIds) {
      const node = this.db.getNode(id);
      if (node) result.push(node);
    }
    return result;
  }

  /** Get all ancestor containers of a node (incoming 'contains' edges). */
  async getAncestors(nodeId: string): Promise<Node[]> {
    return this.traverser.traverseBFS(nodeId, {
      direction: 'incoming',
      edgeKinds: ['contains'],
    });
  }

  /** Get direct children of a node (outgoing 'contains' edges, depth=1). */
  async getChildren(nodeId: string): Promise<Node[]> {
    return this.traverser.traverseBFS(nodeId, {
      direction: 'outgoing',
      edgeKinds: ['contains'],
      maxDepth: 1,
    });
  }

  /** Find all circular import dependencies. Returns arrays of file paths forming cycles. */
  async findCircularDependencies(): Promise<string[][]> {
    return this.db.findCircularDependencies();
  }

  /** Find nodes with no incoming edges (potential dead code). */
  async findDeadCode(limit = 50): Promise<Node[]> {
    return this.db.findDeadCode(limit);
  }

  /** Get metrics for a node (edge counts, callers, callees, children). */
  async getNodeMetrics(nodeId: string): Promise<NodeMetrics> {
    return this.db.getNodeMetrics(nodeId);
  }

  /**
   * Build a subgraph from a set of node IDs, optionally traversing further
   * with the given TraversalOptions.
   */
  async getFilteredSubgraph(nodeIds: string[], opts?: TraversalOptions): Promise<Subgraph> {
    const allNodeIds = new Set<string>(nodeIds);

    if (opts) {
      for (const startId of nodeIds) {
        const traversed = await this.traverser.traverseBFS(startId, opts);
        for (const node of traversed) {
          allNodeIds.add(node.id);
        }
      }
    }

    const ids = [...allNodeIds];
    const nodes: Node[] = [];
    for (const id of ids) {
      const node = this.db.getNode(id);
      if (node) nodes.push(node);
    }

    const edges = this.db.getEdgesForNodes(ids).filter(
      e => allNodeIds.has(e.source) && allNodeIds.has(e.target)
    );

    return { nodes, edges, entryPoints: nodeIds };
  }
}
