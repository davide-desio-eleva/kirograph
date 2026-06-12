export interface GraphNode {
  id: string;
  label: string;
  weight: number;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  kind: 'dependency' | 'call' | 'import' | 'extends';
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  density: number;
  avgDegree: number;
  maxDegree: number;
}

export class Graph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private adjacency = new Map<string, Set<string>>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) {
      this.adjacency.set(node.id, new Set());
    }
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.adjacency.delete(id);
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    const adj = this.adjacency.get(edge.source) ?? new Set<string>();
    adj.add(edge.target);
    this.adjacency.set(edge.source, adj);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  neighbors(id: string): string[] {
    return [...(this.adjacency.get(id) ?? [])];
  }

  stats(): GraphStats {
    const degrees = [...this.adjacency.values()].map(s => s.size);
    const total = degrees.reduce((a, b) => a + b, 0);
    const n = this.nodes.size;
    return {
      nodeCount: n,
      edgeCount: this.edges.length,
      density: n > 1 ? (2 * this.edges.length) / (n * (n - 1)) : 0,
      avgDegree: n > 0 ? total / n : 0,
      maxDegree: degrees.length > 0 ? Math.max(...degrees) : 0,
    };
  }

  bfs(start: string): string[] {
    const visited = new Set<string>();
    const queue = [start];
    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);
      for (const nb of this.neighbors(id)) queue.push(nb);
    }
    return result;
  }

  dfs(start: string): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);
      for (const nb of this.neighbors(id)) stack.push(nb);
    }
    return result;
  }

  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) inDegree.set(id, 0);
    for (const e of this.edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);
      for (const nb of this.neighbors(id)) {
        const d = (inDegree.get(nb) ?? 1) - 1;
        inDegree.set(nb, d);
        if (d === 0) queue.push(nb);
      }
    }
    return result;
  }

  connectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const id of this.nodes.keys()) {
      if (!visited.has(id)) {
        const comp = this.bfs(id);
        comp.forEach(n => visited.add(n));
        components.push(comp);
      }
    }
    return components;
  }

  pageRank(damping = 0.85, iterations = 20): Map<string, number> {
    const n = this.nodes.size;
    const rank = new Map<string, number>();
    for (const id of this.nodes.keys()) rank.set(id, 1 / n);
    for (let i = 0; i < iterations; i++) {
      const newRank = new Map<string, number>();
      for (const id of this.nodes.keys()) {
        let sum = 0;
        for (const e of this.edges) {
          if (e.target === id) {
            const outDeg = this.neighbors(e.source).length;
            sum += (rank.get(e.source) ?? 0) / Math.max(outDeg, 1);
          }
        }
        newRank.set(id, (1 - damping) / n + damping * sum);
      }
      for (const [id, r] of newRank) rank.set(id, r);
    }
    return rank;
  }

  serialize(): object {
    return {
      nodes: [...this.nodes.values()],
      edges: this.edges,
    };
  }

  static deserialize(data: { nodes: GraphNode[]; edges: GraphEdge[] }): Graph {
    const g = new Graph();
    for (const n of data.nodes) g.addNode(n);
    for (const e of data.edges) g.addEdge(e);
    return g;
  }
}

export function buildDependencyGraph(modules: Array<{ id: string; deps: string[] }>): Graph {
  const g = new Graph();
  for (const m of modules) {
    g.addNode({ id: m.id, label: m.id, weight: 1, metadata: {} });
  }
  for (const m of modules) {
    for (const dep of m.deps) {
      g.addEdge({ source: m.id, target: dep, weight: 1, kind: 'dependency' });
    }
  }
  return g;
}

export function detectCycles(g: Graph): string[][] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(id: string, path: string[]): void {
    visited.add(id);
    stack.add(id);
    for (const nb of g.neighbors(id)) {
      if (!visited.has(nb)) {
        dfs(nb, [...path, nb]);
      } else if (stack.has(nb)) {
        const cycleStart = path.indexOf(nb);
        cycles.push(path.slice(cycleStart));
      }
    }
    stack.delete(id);
  }

  for (const id of (g as any).nodes.keys()) {
    if (!visited.has(id)) dfs(id, [id]);
  }
  return cycles;
}
