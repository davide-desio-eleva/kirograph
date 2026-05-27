/**
 * Community Detection via Louvain Algorithm
 *
 * Clusters related code into communities based on edge connectivity.
 * Oversized communities (>25% of graph) are recursively split with higher resolution.
 *
 * Inspired by code-review-graph's Leiden-based community detection.
 */

import type { GraphDatabase } from '../db/database';

export interface Community {
  id: number;
  label: string;
  memberCount: number;
  members: Array<{ id: string; name: string; kind: string; filePath: string }>;
  dominantDirectory: string;
  dominantLanguage: string;
  interCommunityEdges: number;
}

export interface CommunityResult {
  communities: Community[];
  modularity: number;
  totalNodes: number;
  totalEdges: number;
}

interface LouvainNode {
  id: string;
  community: number;
  degree: number;
}

/**
 * Build an undirected weighted adjacency from the edges table.
 * Weight = number of edges between two nodes (calls + imports + references).
 * Excludes 'contains' edges as they're structural, not semantic.
 */
function buildAdjacency(db: GraphDatabase): { nodes: Map<string, LouvainNode>; adj: Map<string, Map<string, number>>; totalWeight: number } {
  const rawDb = db.getRawDb();

  const edges = rawDb.all(
    `SELECT source, target FROM edges WHERE kind != 'contains'`
  ) as Array<{ source: string; target: string }>;

  const nodes = new Map<string, LouvainNode>();
  const adj = new Map<string, Map<string, number>>();
  let totalWeight = 0;

  for (const e of edges) {
    // Ensure both nodes exist
    if (!nodes.has(e.source)) nodes.set(e.source, { id: e.source, community: 0, degree: 0 });
    if (!nodes.has(e.target)) nodes.set(e.target, { id: e.target, community: 0, degree: 0 });

    // Undirected: add weight in both directions
    if (!adj.has(e.source)) adj.set(e.source, new Map());
    if (!adj.has(e.target)) adj.set(e.target, new Map());

    const w1 = adj.get(e.source)!.get(e.target) ?? 0;
    adj.get(e.source)!.set(e.target, w1 + 1);

    const w2 = adj.get(e.target)!.get(e.source) ?? 0;
    adj.get(e.target)!.set(e.source, w2 + 1);

    nodes.get(e.source)!.degree += 1;
    nodes.get(e.target)!.degree += 1;
    totalWeight += 1;
  }

  return { nodes, adj, totalWeight };
}

/**
 * Louvain community detection algorithm (Phase 1: local moving).
 * Assigns each node to the community that maximizes modularity gain.
 */
function louvainPhase1(
  nodes: Map<string, LouvainNode>,
  adj: Map<string, Map<string, number>>,
  totalWeight: number,
  resolution: number = 1.0,
): boolean {
  if (totalWeight === 0) return false;

  const m2 = 2 * totalWeight;
  let improved = false;
  let changed = true;
  let iterations = 0;
  const maxIterations = 20;

  // Community totals: sum of degrees of nodes in each community
  const communityDegree = new Map<number, number>();
  for (const node of nodes.values()) {
    communityDegree.set(node.community, (communityDegree.get(node.community) ?? 0) + node.degree);
  }

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const node of nodes.values()) {
      const currentCommunity = node.community;
      const ki = node.degree;

      // Calculate edges to each neighboring community
      const neighborCommunities = new Map<number, number>();
      const neighbors = adj.get(node.id);
      if (!neighbors) continue;

      for (const [neighborId, weight] of neighbors) {
        const neighborNode = nodes.get(neighborId);
        if (!neighborNode) continue;
        const nc = neighborNode.community;
        neighborCommunities.set(nc, (neighborCommunities.get(nc) ?? 0) + weight);
      }

      // Remove node from its current community
      communityDegree.set(currentCommunity, (communityDegree.get(currentCommunity) ?? 0) - ki);

      // Find best community
      let bestCommunity = currentCommunity;
      let bestGain = 0;

      const kiIn = neighborCommunities.get(currentCommunity) ?? 0;
      const sigmaCurrentWithout = communityDegree.get(currentCommunity) ?? 0;

      for (const [community, edgesToCommunity] of neighborCommunities) {
        if (community === currentCommunity) continue;

        const sigmaCommunity = communityDegree.get(community) ?? 0;

        // Modularity gain formula
        const gain = resolution * (edgesToCommunity - kiIn) / m2
          - resolution * ki * (sigmaCommunity - sigmaCurrentWithout) / (m2 * m2) * 2;

        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = community;
        }
      }

      // Move node to best community
      if (bestCommunity !== currentCommunity) {
        node.community = bestCommunity;
        communityDegree.set(bestCommunity, (communityDegree.get(bestCommunity) ?? 0) + ki);
        changed = true;
        improved = true;
      } else {
        communityDegree.set(currentCommunity, (communityDegree.get(currentCommunity) ?? 0) + ki);
      }
    }
  }

  return improved;
}

/**
 * Calculate modularity of the current partition.
 */
function calculateModularity(
  nodes: Map<string, LouvainNode>,
  adj: Map<string, Map<string, number>>,
  totalWeight: number,
): number {
  if (totalWeight === 0) return 0;

  const m2 = 2 * totalWeight;
  let q = 0;

  for (const [nodeId, node] of nodes) {
    const neighbors = adj.get(nodeId);
    if (!neighbors) continue;

    for (const [neighborId, weight] of neighbors) {
      const neighborNode = nodes.get(neighborId);
      if (!neighborNode) continue;

      if (node.community === neighborNode.community) {
        q += weight - (node.degree * neighborNode.degree) / m2;
      }
    }
  }

  return q / m2;
}

/**
 * Run community detection on the graph.
 */
export function detectCommunities(db: GraphDatabase, opts?: { resolution?: number; maxCommunityPct?: number }): CommunityResult {
  const resolution = opts?.resolution ?? 1.0;
  const maxCommunityPct = opts?.maxCommunityPct ?? 0.25;

  const { nodes, adj, totalWeight } = buildAdjacency(db);

  if (nodes.size === 0) {
    return { communities: [], modularity: 0, totalNodes: 0, totalEdges: 0 };
  }

  // Initialize: each node in its own community
  let communityId = 0;
  for (const node of nodes.values()) {
    node.community = communityId++;
  }

  // Run Louvain Phase 1
  louvainPhase1(nodes, adj, totalWeight, resolution);

  // Auto-split oversized communities
  const communityMembers = new Map<number, string[]>();
  for (const node of nodes.values()) {
    if (!communityMembers.has(node.community)) communityMembers.set(node.community, []);
    communityMembers.get(node.community)!.push(node.id);
  }

  const maxSize = Math.floor(nodes.size * maxCommunityPct);
  for (const [cId, members] of communityMembers) {
    if (members.length > maxSize) {
      // Re-run with higher resolution on this subgraph
      const subNodes = new Map<string, LouvainNode>();
      let subCommunityId = communityId;
      for (const mId of members) {
        const original = nodes.get(mId)!;
        subNodes.set(mId, { ...original, community: subCommunityId++ });
      }
      communityId = subCommunityId;

      // Build sub-adjacency
      const subAdj = new Map<string, Map<string, number>>();
      let subWeight = 0;
      for (const mId of members) {
        const neighbors = adj.get(mId);
        if (!neighbors) continue;
        for (const [nId, w] of neighbors) {
          if (subNodes.has(nId)) {
            if (!subAdj.has(mId)) subAdj.set(mId, new Map());
            subAdj.get(mId)!.set(nId, w);
            subWeight += w;
          }
        }
      }

      louvainPhase1(subNodes, subAdj, subWeight / 2, resolution * 2);

      // Apply sub-community assignments back
      for (const [mId, subNode] of subNodes) {
        nodes.get(mId)!.community = subNode.community;
      }
    }
  }

  // Build result
  const rawDb = db.getRawDb();
  const finalCommunities = new Map<number, Array<{ id: string; name: string; kind: string; filePath: string }>>();

  for (const node of nodes.values()) {
    if (!finalCommunities.has(node.community)) finalCommunities.set(node.community, []);
    const nodeInfo = rawDb.get(
      'SELECT name, kind, file_path as filePath FROM nodes WHERE id = ?',
      [node.id]
    ) as any;
    if (nodeInfo) {
      finalCommunities.get(node.community)!.push({
        id: node.id,
        name: nodeInfo.name,
        kind: nodeInfo.kind,
        filePath: nodeInfo.filePath,
      });
    }
  }

  // Calculate inter-community edges
  const interEdges = new Map<number, number>();
  for (const [nodeId, node] of nodes) {
    const neighbors = adj.get(nodeId);
    if (!neighbors) continue;
    for (const [neighborId] of neighbors) {
      const neighborNode = nodes.get(neighborId);
      if (neighborNode && neighborNode.community !== node.community) {
        interEdges.set(node.community, (interEdges.get(node.community) ?? 0) + 1);
      }
    }
  }

  // Build community objects
  const communities: Community[] = [];
  let idx = 0;
  for (const [cId, members] of finalCommunities) {
    if (members.length === 0) continue;

    // Dominant directory
    const dirCounts = new Map<string, number>();
    const langCounts = new Map<string, number>();
    for (const m of members) {
      const dir = m.filePath.split('/').slice(0, 2).join('/');
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      const ext = m.filePath.split('.').pop() ?? '';
      langCounts.set(ext, (langCounts.get(ext) ?? 0) + 1);
    }

    const dominantDirectory = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const dominantLanguage = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    // Generate label from dominant directory or top symbol
    const label = dominantDirectory || members[0]?.name || `community-${idx}`;

    communities.push({
      id: idx++,
      label,
      memberCount: members.length,
      members: members.slice(0, 30), // Cap for output size
      dominantDirectory,
      dominantLanguage,
      interCommunityEdges: interEdges.get(cId) ?? 0,
    });
  }

  // Sort by size descending
  communities.sort((a, b) => b.memberCount - a.memberCount);

  const modularity = calculateModularity(nodes, adj, totalWeight);

  return {
    communities,
    modularity,
    totalNodes: nodes.size,
    totalEdges: totalWeight,
  };
}
