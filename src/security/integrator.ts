/**
 * DependencyGraphIntegrator
 *
 * Links dependency nodes to code symbols via import and reference edges,
 * resolves transitive dependencies from lock files, and cleans up orphaned nodes.
 *
 * Integration flow:
 * 1. integrate() — Scan file nodes for import statements resolving to dependencies,
 *    create `imports` and `references` edges.
 * 2. resolveTransitives(maxDepth) — Parse lock files to discover transitive dependency
 *    relationships, create `depends_on` edges between Dependency_Nodes.
 * 3. cleanup() — Remove orphaned Dependency_Nodes no longer declared in any manifest.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { GraphDatabase } from '../db/database';
import type { Edge } from '../types';
import type { IntegrationResult, TransitiveResult, CleanupResult } from './types';
import { logWarn, logDebug } from '../errors';

// ── Lock File Parsers ─────────────────────────────────────────────────────────

/**
 * Transitive dependency relationship: parent depends on child.
 */
interface TransitiveDep {
  parent: string;
  child: string;
}

/**
 * Parse package-lock.json (v2/v3) to extract transitive dependency relationships.
 * Returns pairs of (parent, child) where parent depends on child.
 */
function parseNpmLockTransitives(lockPath: string): TransitiveDep[] {
  const deps: TransitiveDep[] = [];
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const lockData = JSON.parse(content);

    if (typeof lockData !== 'object' || lockData === null) return deps;

    const packages = lockData.packages;
    if (typeof packages !== 'object' || packages === null) {
      // Try lockfileVersion 1 format
      return parseNpmLockV1Transitives(lockData);
    }

    // lockfileVersion 2/3: packages field with nested node_modules paths
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (key === '') continue; // skip root
      if (typeof value !== 'object' || value === null) continue;
      const pkg = value as Record<string, unknown>;

      // Extract the package name from the key
      const parentName = key.replace(/^.*node_modules\//, '');
      if (!parentName) continue;

      // Extract this package's dependencies
      const allDeps: Record<string, unknown> = {};
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const fieldDeps = pkg[field];
        if (typeof fieldDeps === 'object' && fieldDeps !== null) {
          Object.assign(allDeps, fieldDeps);
        }
      }

      for (const childName of Object.keys(allDeps)) {
        deps.push({ parent: parentName, child: childName });
      }
    }
  } catch {
    // Lock file parse failure — return empty
  }
  return deps;
}

/**
 * Parse lockfileVersion 1 format (nested dependencies object).
 */
function parseNpmLockV1Transitives(lockData: Record<string, unknown>): TransitiveDep[] {
  const deps: TransitiveDep[] = [];
  const topDeps = lockData.dependencies;
  if (typeof topDeps !== 'object' || topDeps === null) return deps;

  function recurse(parentDeps: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(parentDeps)) {
      if (typeof value !== 'object' || value === null) continue;
      const pkg = value as Record<string, unknown>;

      // Check for requires (direct dependencies of this package)
      const requires = pkg.requires;
      if (typeof requires === 'object' && requires !== null) {
        for (const childName of Object.keys(requires as Record<string, unknown>)) {
          deps.push({ parent: name, child: childName });
        }
      }

      // Recurse into nested dependencies
      const nested = pkg.dependencies;
      if (typeof nested === 'object' && nested !== null) {
        recurse(nested as Record<string, unknown>);
      }
    }
  }

  recurse(topDeps as Record<string, unknown>);
  return deps;
}

/**
 * Parse Cargo.lock to extract transitive dependency relationships.
 * Cargo.lock [[package]] blocks have a `dependencies` field listing direct deps.
 */
function parseCargoLockTransitives(lockPath: string): TransitiveDep[] {
  const deps: TransitiveDep[] = [];
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const lines = content.split('\n');

    let currentName: string | null = null;
    let inDeps = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '[[package]]') {
        currentName = null;
        inDeps = false;
        continue;
      }

      if (currentName === null) {
        const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"$/);
        if (nameMatch) {
          currentName = nameMatch[1];
          continue;
        }
      }

      if (currentName !== null && trimmed === 'dependencies = [') {
        inDeps = true;
        continue;
      }

      if (inDeps) {
        if (trimmed === ']') {
          inDeps = false;
          continue;
        }
        // Lines like: "serde_derive 1.0.193 (registry+...)",
        // or simply: "serde_derive",
        const depMatch = trimmed.match(/^\s*"([^"\s]+)/);
        if (depMatch && currentName) {
          deps.push({ parent: currentName, child: depMatch[1] });
        }
      }
    }
  } catch {
    // Lock file parse failure — return empty
  }
  return deps;
}

/**
 * Parse go.sum to extract module dependency relationships.
 * go.sum doesn't directly encode dependency trees, so we parse go.mod
 * for the require directives. For transitive resolution, we'd need
 * `go mod graph` output, but for the MVP we mark Go deps as incomplete
 * if no explicit dependency tree is available.
 *
 * Returns empty — Go transitive resolution requires `go mod graph` which
 * is not available at index time. Nodes will be marked incomplete.
 */
function parseGoTransitives(_lockPath: string): TransitiveDep[] {
  // Go modules don't have a lock file that encodes the dependency tree.
  // go.sum only provides checksums. Full transitive resolution requires
  // running `go mod graph` which is out of scope for static analysis.
  return [];
}

/**
 * Parse pip's requirements files for transitive dependencies.
 * pip doesn't have a standard lock file with dependency trees.
 * Returns empty — nodes will be marked incomplete.
 */
function parsePipTransitives(_lockPath: string): TransitiveDep[] {
  return [];
}

// ── Lock File Discovery ───────────────────────────────────────────────────────

interface LockFileInfo {
  ecosystem: string;
  lockPath: string;
  parser: (lockPath: string) => TransitiveDep[];
}

/**
 * Discover lock files in the project root for each ecosystem.
 */
function discoverLockFiles(projectRoot: string): LockFileInfo[] {
  const lockFiles: LockFileInfo[] = [];

  const candidates: Array<{ ecosystem: string; filename: string; parser: (p: string) => TransitiveDep[] }> = [
    { ecosystem: 'npm', filename: 'package-lock.json', parser: parseNpmLockTransitives },
    { ecosystem: 'npm', filename: 'yarn.lock', parser: parseNpmLockTransitives },
    { ecosystem: 'cargo', filename: 'Cargo.lock', parser: parseCargoLockTransitives },
    { ecosystem: 'go', filename: 'go.sum', parser: parseGoTransitives },
    { ecosystem: 'python', filename: 'requirements.txt', parser: parsePipTransitives },
  ];

  for (const candidate of candidates) {
    const lockPath = path.join(projectRoot, candidate.filename);
    if (fs.existsSync(lockPath)) {
      lockFiles.push({
        ecosystem: candidate.ecosystem,
        lockPath,
        parser: candidate.parser,
      });
    }
  }

  return lockFiles;
}

// ── DependencyGraphIntegrator Class ───────────────────────────────────────────

export class DependencyGraphIntegrator {
  private readonly db: GraphDatabase;
  private readonly projectRoot: string;

  constructor(db: GraphDatabase, projectRoot: string) {
    this.db = db;
    this.projectRoot = projectRoot;
  }

  /**
   * Create import/reference edges between code symbols and Dependency_Nodes.
   *
   * Per Requirement 2.1: creates `imports` edges from file nodes that contain
   * import statements resolving to a dependency → the Dependency_Node.
   *
   * Per Requirement 2.2: creates `references` edges from code symbols that
   * reference classes/functions from a dependency → the Dependency_Node.
   */
  async integrate(): Promise<IntegrationResult> {
    let importsEdgesCreated = 0;
    let referencesEdgesCreated = 0;

    const rawDb = this.db.getRawDb();

    // Get all dependency nodes with their package names and ecosystems
    const depRows: Array<{ node_id: string; package_name: string; ecosystem: string }> =
      rawDb.all('SELECT node_id, package_name, ecosystem FROM sec_dependencies');

    if (depRows.length === 0) {
      return { importsEdgesCreated, referencesEdgesCreated };
    }

    // Build a lookup map: package name → dependency node ID
    const depByName = new Map<string, string>();
    for (const row of depRows) {
      depByName.set(row.package_name, row.node_id);
    }

    // ── Step 1: Create `imports` edges (file → dependency) ────────────────────
    // Scan import nodes. The import node's `name` field contains the module
    // specifier (e.g., 'express', '@nestjs/core', 'github.com/gin-gonic/gin').
    // For each match, create an edge from the FILE node to the Dependency_Node.
    const importNodes = this.db.getNodesByKind('import');

    // Track (file, dep) pairs to avoid duplicate edges
    const createdImportEdges = new Set<string>();

    for (const importNode of importNodes) {
      // Use the import node's `name` field which is the raw module specifier
      const specifier = importNode.name;

      const matchedDepId = this.matchImportToDependency(specifier, depByName);
      if (!matchedDepId) continue;

      // Find the file node for this import's file path
      const fileNodeId = this.findFileNodeId(rawDb, importNode.filePath);
      if (!fileNodeId) continue;

      const edgeKey = `${fileNodeId}→${matchedDepId}`;
      if (createdImportEdges.has(edgeKey)) continue;

      const edge: Edge = {
        source: fileNodeId,
        target: matchedDepId,
        kind: 'imports',
        line: importNode.startLine,
        confidence: 'inferred',
        confidenceScore: 0.9,
      };
      this.db.insertEdge(edge);
      createdImportEdges.add(edgeKey);
      importsEdgesCreated++;
    }

    // ── Step 2: Create `references` edges (code symbol → dependency) ──────────
    // For each import node that matched a dependency, find code symbols in the
    // same file that call or reference that import node. Those symbols effectively
    // reference the dependency.
    const codeKinds = new Set(['function', 'method', 'class', 'variable', 'constant', 'property']);
    const createdRefEdges = new Set<string>();

    for (const importNode of importNodes) {
      const specifier = importNode.name;
      const matchedDepId = this.matchImportToDependency(specifier, depByName);
      if (!matchedDepId) continue;

      // Get all nodes in the same file
      const fileNodes = this.db.getNodesByFile(importNode.filePath);
      const codeSymbols = fileNodes.filter(n => codeKinds.has(n.kind));
      if (codeSymbols.length === 0) continue;

      // Check edges from code symbols to this import node
      const symbolIds = codeSymbols.map(n => n.id);
      const edges = this.db.getEdgesForNodes(symbolIds);

      for (const edge of edges) {
        // A code symbol calls or references the import node → it references the dependency
        if (
          (edge.kind === 'calls' || edge.kind === 'references') &&
          edge.target === importNode.id &&
          symbolIds.includes(edge.source)
        ) {
          const refKey = `${edge.source}→${matchedDepId}`;
          if (createdRefEdges.has(refKey)) continue;

          const refEdge: Edge = {
            source: edge.source,
            target: matchedDepId,
            kind: 'references',
            confidence: 'inferred',
            confidenceScore: 0.8,
          };
          this.db.insertEdge(refEdge);
          createdRefEdges.add(refKey);
          referencesEdgesCreated++;
        }
      }
    }

    return { importsEdgesCreated, referencesEdgesCreated };
  }

  /**
   * Find the file node ID for a given file path.
   * File nodes have kind='file' and their file_path matches.
   */
  private findFileNodeId(rawDb: any, filePath: string): string | null {
    const row = rawDb.get(
      'SELECT id FROM nodes WHERE kind = ? AND file_path = ? LIMIT 1',
      ['file', filePath],
    );
    return row ? row.id : null;
  }

  /**
   * Match an import specifier to a dependency node ID.
   *
   * Handles:
   * - Exact match: `express` → dep:npm:express
   * - Scoped packages: `@scope/pkg` → dep:npm:@scope/pkg
   * - Subpath imports: `express/Router` → dep:npm:express
   * - Scoped subpath: `@angular/core/testing` → dep:npm:@angular/core
   * - Go modules: `github.com/gin-gonic/gin` → dep:go:github.com/gin-gonic/gin
   * - Go subpath: `github.com/gin-gonic/gin/internal` → dep:go:github.com/gin-gonic/gin
   */
  private matchImportToDependency(
    specifier: string,
    depByName: Map<string, string>,
  ): string | null {
    if (!specifier) return null;

    // Skip relative imports
    if (specifier.startsWith('.') || specifier.startsWith('/')) return null;

    // Direct match
    if (depByName.has(specifier)) {
      return depByName.get(specifier)!;
    }

    // For scoped packages: @scope/name/subpath → @scope/name
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      if (parts.length >= 2) {
        const scopedName = `${parts[0]}/${parts[1]}`;
        if (depByName.has(scopedName)) {
          return depByName.get(scopedName)!;
        }
      }
    }

    // For unscoped packages: name/subpath → name
    if (!specifier.startsWith('@')) {
      const slashIdx = specifier.indexOf('/');
      if (slashIdx > 0) {
        const baseName = specifier.slice(0, slashIdx);
        if (depByName.has(baseName)) {
          return depByName.get(baseName)!;
        }
      }
    }

    // Go module path matching: try progressively shorter prefixes
    // e.g. github.com/gin-gonic/gin/internal → github.com/gin-gonic/gin
    if (specifier.includes('.') && specifier.includes('/')) {
      const parts = specifier.split('/');
      for (let i = parts.length - 1; i >= 2; i--) {
        const prefix = parts.slice(0, i).join('/');
        if (depByName.has(prefix)) {
          return depByName.get(prefix)!;
        }
      }
    }

    return null;
  }

  /**
   * Resolve transitive dependencies up to maxDepth levels.
   *
   * For each ecosystem with a lock file:
   * 1. Parse the lock file to extract dependency relationships
   * 2. Create `depends_on` edges between Dependency_Nodes
   * 3. Traverse up to maxDepth levels of transitive depth
   *
   * If a lock file is missing for an ecosystem, mark all dependencies of that
   * ecosystem with `transitive_status: 'incomplete'` and log a warning.
   *
   * @param maxDepth - Maximum levels of transitive depth to resolve (default: 10)
   */
  async resolveTransitives(maxDepth: number = 10): Promise<TransitiveResult> {
    let dependsOnEdgesCreated = 0;
    const incompleteNodes: string[] = [];
    const rawDb = this.db.getRawDb();

    // Get all dependency nodes grouped by ecosystem
    const depRows: Array<{ node_id: string; package_name: string; ecosystem: string }> =
      rawDb.all('SELECT node_id, package_name, ecosystem FROM sec_dependencies');

    if (depRows.length === 0) {
      return { dependsOnEdgesCreated, incompleteNodes };
    }

    // Group dependencies by ecosystem
    const depsByEcosystem = new Map<string, Map<string, string>>();
    for (const row of depRows) {
      if (!depsByEcosystem.has(row.ecosystem)) {
        depsByEcosystem.set(row.ecosystem, new Map());
      }
      depsByEcosystem.get(row.ecosystem)!.set(row.package_name, row.node_id);
    }

    // Discover available lock files
    const lockFiles = discoverLockFiles(this.projectRoot);
    const ecosystemsWithLockFile = new Set(lockFiles.map(lf => lf.ecosystem));

    // Mark ecosystems without lock files as incomplete
    for (const [ecosystem, depsMap] of depsByEcosystem) {
      if (!ecosystemsWithLockFile.has(ecosystem)) {
        // No lock file for this ecosystem — mark all deps as incomplete and log once per ecosystem.
        for (const [, nodeId] of depsMap) {
          rawDb.run(
            `UPDATE sec_dependencies SET transitive_status = 'incomplete' WHERE node_id = ?`,
            [nodeId],
          );
          incompleteNodes.push(nodeId);
        }
        logDebug(
          `[sec:integrator] No lock file parser for ${ecosystem} — transitive depth unavailable for ` +
          `${depsMap.size} package(s). Direct vulnerability scanning is unaffected.`,
        );
      }
    }

    // Parse each lock file and create depends_on edges
    for (const lockFile of lockFiles) {
      const transitives = lockFile.parser(lockFile.lockPath);
      const ecosystemDeps = depsByEcosystem.get(lockFile.ecosystem);
      if (!ecosystemDeps) continue;

      if (transitives.length === 0 && ecosystemDeps.size > 0) {
        // Lock file exists but yielded no transitive info (e.g., go.sum has only checksums,
        // pip requirements.txt has no tree). Mark all deps incomplete and log once per ecosystem.
        if (lockFile.ecosystem === 'go' || lockFile.ecosystem === 'python') {
          for (const [, nodeId] of ecosystemDeps) {
            rawDb.run(
              `UPDATE sec_dependencies SET transitive_status = 'incomplete' WHERE node_id = ?`,
              [nodeId],
            );
            incompleteNodes.push(nodeId);
          }
          // Single debug note per ecosystem — known limitation, not an error.
          logDebug(
            `[sec:integrator] ${lockFile.ecosystem === 'go' ? 'go.sum' : 'requirements.txt'} does not encode a ` +
            `dependency tree — transitive depth unavailable for ${ecosystemDeps.size} ${lockFile.ecosystem} ` +
            `package(s). Direct vulnerability scanning is unaffected.`,
          );
        }
        continue;
      }

      // Build adjacency list from transitive relationships
      const adjacency = new Map<string, Set<string>>();
      for (const { parent, child } of transitives) {
        if (!adjacency.has(parent)) {
          adjacency.set(parent, new Set());
        }
        adjacency.get(parent)!.add(child);
      }

      // BFS from each direct dependency up to maxDepth levels
      // Create depends_on edges only between nodes that exist in our dep graph
      const createdEdges = new Set<string>();

      for (const [pkgName, nodeId] of ecosystemDeps) {
        const visited = new Set<string>([pkgName]);
        let frontier = [pkgName];
        let depth = 0;

        while (frontier.length > 0 && depth < maxDepth) {
          const nextFrontier: string[] = [];
          depth++;

          for (const current of frontier) {
            const children = adjacency.get(current);
            if (!children) continue;

            for (const child of children) {
              if (visited.has(child)) continue;
              visited.add(child);

              // Create depends_on edge if the child is a known dependency node
              const childNodeId = ecosystemDeps.get(child);
              const parentNodeId = current === pkgName ? nodeId : ecosystemDeps.get(current);

              if (parentNodeId && childNodeId) {
                const edgeKey = `${parentNodeId}->${childNodeId}`;
                if (!createdEdges.has(edgeKey)) {
                  const edge: Edge = {
                    source: parentNodeId,
                    target: childNodeId,
                    kind: 'depends_on',
                    confidence: 'inferred',
                    confidenceScore: 1.0,
                  };
                  this.db.insertEdge(edge);
                  createdEdges.add(edgeKey);
                  dependsOnEdgesCreated++;
                }
              }

              nextFrontier.push(child);
            }
          }

          frontier = nextFrontier;
        }
      }
    }

    return { dependsOnEdgesCreated, incompleteNodes };
  }

  /**
   * Remove orphaned Dependency_Nodes and their edges.
   *
   * A Dependency_Node is orphaned if:
   * 1. It has no `declared_in` edges (manifest no longer declares it), OR
   * 2. None of its source manifests still exist on disk
   *
   * Also removes transitive Dependency_Nodes that are no longer reachable from
   * any remaining direct dependency via `depends_on` edges.
   *
   * @param manifestExists - Optional function to check if a manifest path exists.
   *   Defaults to fs.existsSync. Useful for testing.
   */
  async cleanup(manifestExists?: (absolutePath: string) => boolean): Promise<CleanupResult> {
    let nodesRemoved = 0;
    let edgesRemoved = 0;
    const rawDb = this.db.getRawDb();
    const checkExists = manifestExists ?? ((p: string) => fs.existsSync(p));

    // Step 1: Find dependency nodes that are orphaned because they have no
    // declared_in edges (manifest no longer declares them)
    const orphanedByEdge: Array<{ node_id: string }> = rawDb.all(
      `SELECT sd.node_id FROM sec_dependencies sd
       WHERE NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE e.source = sd.node_id AND e.kind = 'declared_in'
       )`,
    );

    const orphanedNodeIds = new Set<string>(orphanedByEdge.map(r => r.node_id));

    // Step 2: Also check if source manifests still exist on disk
    const allDeps: Array<{ node_id: string; source_manifests: string }> = rawDb.all(
      `SELECT node_id, source_manifests FROM sec_dependencies`,
    );

    for (const dep of allDeps) {
      if (orphanedNodeIds.has(dep.node_id)) continue; // already marked

      const sourceManifests: string[] = JSON.parse(dep.source_manifests);
      const hasValidManifest = sourceManifests.some(manifest => {
        const absolutePath = path.isAbsolute(manifest)
          ? manifest
          : path.join(this.projectRoot, manifest);
        return checkExists(absolutePath);
      });

      if (!hasValidManifest) {
        orphanedNodeIds.add(dep.node_id);
      }
    }

    // Step 3: Find transitive Dependency_Nodes no longer reachable from any
    // remaining direct dependency via `depends_on` edges
    const remainingNodeIds = new Set<string>(
      allDeps
        .filter(d => !orphanedNodeIds.has(d.node_id))
        .map(d => d.node_id),
    );

    // BFS from remaining nodes following `depends_on` edges to find all reachable transitives
    const reachableFromDirect = new Set<string>(remainingNodeIds);
    let frontier = [...remainingNodeIds];

    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(',');
      const nextRows: Array<{ target: string }> = rawDb.all(
        `SELECT DISTINCT target FROM edges WHERE source IN (${placeholders}) AND kind = 'depends_on'`,
        frontier,
      );

      frontier = [];
      for (const row of nextRows) {
        if (!reachableFromDirect.has(row.target)) {
          reachableFromDirect.add(row.target);
          frontier.push(row.target);
        }
      }
    }

    // Any dependency node that is NOT reachable from a remaining direct dependency is also orphaned
    for (const dep of allDeps) {
      if (!orphanedNodeIds.has(dep.node_id) && !reachableFromDirect.has(dep.node_id)) {
        orphanedNodeIds.add(dep.node_id);
      }
    }

    if (orphanedNodeIds.size === 0) {
      return { nodesRemoved: 0, edgesRemoved: 0 };
    }

    // Step 4: Remove orphaned nodes and their edges
    const orphanedIds = [...orphanedNodeIds];

    for (const nodeId of orphanedIds) {
      // Count edges being removed
      const edgeCount = rawDb.get(
        `SELECT COUNT(*) as c FROM edges
         WHERE source = ? OR target = ?`,
        [nodeId, nodeId],
      );
      edgesRemoved += edgeCount?.c ?? 0;

      // Delete edges connected to this node
      rawDb.run('DELETE FROM edges WHERE source = ? OR target = ?', [nodeId, nodeId]);

      // Remove from sec_dependencies (explicit delete before nodes for clarity)
      rawDb.run('DELETE FROM sec_dependencies WHERE node_id = ?', [nodeId]);

      // Remove from nodes table
      rawDb.run('DELETE FROM nodes WHERE id = ?', [nodeId]);

      // Clean up FTS entries
      rawDb.run('DELETE FROM nodes_fts WHERE id = ?', [nodeId]);

      nodesRemoved++;
    }

    return { nodesRemoved, edgesRemoved };
  }
}
