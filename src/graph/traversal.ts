/**
 * KiroGraph Graph Traversal Module
 * Provides BFS and DFS traversal over the knowledge graph.
 */

import type { Node, EdgeKind, NodeKind } from '../types';
import type { GraphDatabase } from '../db/database';

export interface TraversalOptions {
  maxDepth?: number;
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
  direction?: 'outgoing' | 'incoming' | 'both';
  limit?: number;
  includeStart?: boolean;
}

export class GraphTraverser {
  constructor(private readonly db: GraphDatabase) {}

  /**
   * Breadth-first traversal from startId.
   * Visits all nodes at depth D before any node at depth D+1.
   */
  async traverseBFS(startId: string, opts: TraversalOptions = {}): Promise<Node[]> {
    const {
      maxDepth = Infinity,
      edgeKinds,
      nodeKinds,
      direction = 'outgoing',
      limit = Infinity,
      includeStart = false,
    } = opts;

    const visited = new Set<string>();
    const result: Node[] = [];

    // Queue entries: [nodeId, depth]
    const queue: Array<[string, number]> = [[startId, 0]];
    visited.add(startId);

    while (queue.length > 0) {
      const [currentId, depth] = queue.shift()!;

      // Include the start node only if requested
      if (currentId === startId) {
        if (includeStart) {
          const node = this.db.getNode(currentId);
          if (node && this.matchesNodeKinds(node, nodeKinds)) {
            result.push(node);
            if (result.length >= limit) break;
          }
        }
      } else {
        const node = this.db.getNode(currentId);
        if (node && this.matchesNodeKinds(node, nodeKinds)) {
          result.push(node);
          if (result.length >= limit) break;
        }
      }

      if (depth >= maxDepth) continue;

      // Get neighbors
      const neighbors = this.getNeighbors(currentId, direction, edgeKinds);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push([neighborId, depth + 1]);
        }
      }
    }

    return result;
  }

  /**
   * Depth-first traversal from startId.
   */
  async traverseDFS(startId: string, opts: TraversalOptions = {}): Promise<Node[]> {
    const {
      maxDepth = Infinity,
      edgeKinds,
      nodeKinds,
      direction = 'outgoing',
      limit = Infinity,
      includeStart = false,
    } = opts;

    const visited = new Set<string>();
    const result: Node[] = [];

    const dfs = (currentId: string, depth: number): void => {
      if (result.length >= limit) return;
      if (visited.has(currentId)) return;
      visited.add(currentId);

      if (currentId === startId) {
        if (includeStart) {
          const node = this.db.getNode(currentId);
          if (node && this.matchesNodeKinds(node, nodeKinds)) {
            result.push(node);
          }
        }
      } else {
        const node = this.db.getNode(currentId);
        if (node && this.matchesNodeKinds(node, nodeKinds)) {
          result.push(node);
        }
      }

      if (depth >= maxDepth) return;

      const neighbors = this.getNeighbors(currentId, direction, edgeKinds);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          dfs(neighborId, depth + 1);
          if (result.length >= limit) return;
        }
      }
    };

    dfs(startId, 0);
    return result;
  }

  /**
   * Get neighbor node IDs from the database, filtered by direction and edge kinds.
   */
  private getNeighbors(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): string[] {
    const neighbors: string[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const edges = this.getOutgoingEdges(nodeId, edgeKinds);
      for (const e of edges) neighbors.push(e.target);
    }

    if (direction === 'incoming' || direction === 'both') {
      const edges = this.getIncomingEdges(nodeId, edgeKinds);
      for (const e of edges) neighbors.push(e.target);
    }

    return neighbors;
  }

  private getOutgoingEdges(nodeId: string, edgeKinds?: EdgeKind[]): Array<{ target: string }> {
    // Use getEdgesForNodes and filter manually since db doesn't expose raw edge queries
    const allEdges = this.db.getEdgesForNodes([nodeId]);
    return allEdges
      .filter(e => e.source === nodeId)
      .filter(e => !edgeKinds || edgeKinds.includes(e.kind))
      .map(e => ({ target: e.target }));
  }

  private getIncomingEdges(nodeId: string, edgeKinds?: EdgeKind[]): Array<{ target: string }> {
    const allEdges = this.db.getEdgesForNodes([nodeId]);
    return allEdges
      .filter(e => e.target === nodeId)
      .filter(e => !edgeKinds || edgeKinds.includes(e.kind))
      .map(e => ({ target: e.source }));
  }

  private matchesNodeKinds(node: Node, nodeKinds?: NodeKind[]): boolean {
    if (!nodeKinds || nodeKinds.length === 0) return true;
    return nodeKinds.includes(node.kind);
  }
}
