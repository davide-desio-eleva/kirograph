/**
 * ArchitectureAnalyzer
 *
 * Orchestrates the full architecture analysis pipeline:
 *   1. Parse manifests → packages
 *   2. Directory-based fallback for uncovered file trees
 *   3. Detect layers from file paths
 *   4. Roll up package-to-package dependencies from existing import edges
 *   5. Roll up layer-to-layer dependencies
 *   6. Compute coupling metrics (Ca, Ce, instability)
 *
 * Only runs when enableArchitecture=true. Writes to arch_* tables in kirograph.db.
 */
import * as path from 'path';
import type { GraphDatabase } from '../db/database';
import type { KiroGraphConfig } from '../config';
import type {
  ArchPackage, ArchLayer, ArchPackageDep, ArchLayerDep, ArchCoupling, ArchitectureResult,
} from './types';
import { parseAllManifests } from './manifest/index';
import { detectAllLayers, buildArchLayers, type FileLayerAssignment } from './layers/index';

export class ArchitectureAnalyzer {
  constructor(
    private readonly db: GraphDatabase,
    private readonly config: KiroGraphConfig,
    private readonly projectRoot: string,
  ) {}

  async analyze(onProgress?: (msg: string) => void): Promise<ArchitectureResult> {
    const log = (msg: string) => onProgress?.(msg);

    // ── 1. Parse manifests ─────────────────────────────────────────────────────
    log('architecture: parsing manifests');
    const manifestPackages = await parseAllManifests(this.projectRoot, {
      include: this.config.include,
      exclude: this.config.exclude,
    });

    // ── 2. Get all indexed files ───────────────────────────────────────────────
    const allFiles = this.db.getAllFiles().map(f => f.path); // relative paths

    // ── 3. Assign files to packages (manifest-based) ──────────────────────────
    log('architecture: assigning files to packages');
    const filePackageMap = new Map<string, string>(); // filePath → packageId
    // Sort packages by path length desc so the most-specific package wins
    const sortedPkgs = [...manifestPackages].sort((a, b) => b.path.length - a.path.length);
    for (const file of allFiles) {
      for (const pkg of sortedPkgs) {
        const pkgPath = pkg.path === '.' ? '' : pkg.path + '/';
        if (pkg.path === '.' || file.startsWith(pkgPath)) {
          filePackageMap.set(file, pkg.id);
          break;
        }
      }
    }

    // ── 4. Directory-based fallback / subdivision ──────────────────────────────
    //
    // Three cases:
    //   A) No manifests at all → group by top-level directory.
    //   B) Root manifest (path='.') covers everything → subdivide its files into
    //      second-level directory packages so internal structure is visible.
    //   C) Manifests exist but don't cover the whole tree → create directory
    //      packages for uncovered subdirectories (threshold: 3 files).
    //
    const SUBDIR_THRESHOLD = 1;
    const directoryPackages: ArchPackage[] = [];

    const rootManifestIds = new Set(manifestPackages.filter(p => p.path === '.').map(p => p.id));
    const hasRootManifest = rootManifestIds.size > 0;

    if (manifestPackages.length === 0) {
      // Case A: no manifests — group by top-level directory
      const topDirs = new Set<string>();
      for (const file of allFiles) {
        const parts = file.split('/');
        if (parts.length > 1) topDirs.add(parts[0]);
      }
      for (const dir of topDirs) {
        const pkgId = `pkg:dir:${dir}`;
        directoryPackages.push({ id: pkgId, name: dir, path: dir, source: 'directory', updatedAt: Date.now() });
        for (const file of allFiles) {
          if (file.startsWith(dir + '/')) filePackageMap.set(file, pkgId);
        }
      }
    } else if (hasRootManifest) {
      // Case B: root manifest(s) cover everything — subdivide into second-level dirs.
      // Collect files owned by a root manifest, then re-assign them to more specific
      // directory packages so internal module boundaries become visible.
      const rootOwnedFiles = allFiles.filter(f => rootManifestIds.has(filePackageMap.get(f) ?? ''));
      const subDirCounts = new Map<string, number>();
      for (const file of rootOwnedFiles) {
        const parts = file.split('/');
        if (parts.length > 2) {
          // Use two-level path (e.g. src/mcp) for granularity inside a src root
          const dir = parts.slice(0, 2).join('/');
          subDirCounts.set(dir, (subDirCounts.get(dir) ?? 0) + 1);
        }
        // Files directly at one level deep (e.g. src/index.ts) stay with the
        // root manifest package — no single-level dir package is created.
      }
      for (const [dir, count] of subDirCounts) {
        if (count >= SUBDIR_THRESHOLD) {
          const pkgId = `pkg:dir:${dir}`;
          const name = dir.split('/').pop() ?? dir;
          const pkg: ArchPackage = { id: pkgId, name, path: dir, source: 'directory', updatedAt: Date.now() };
          directoryPackages.push(pkg);
          for (const file of rootOwnedFiles) {
            if (file.startsWith(dir + '/') || file === dir) {
              filePackageMap.set(file, pkgId);
            }
          }
        }
      }
    } else {
      // Case C: manifests exist but don't cover root — create dir packages for uncovered files
      const uncovered = allFiles.filter(f => !filePackageMap.has(f));
      const subDirCounts = new Map<string, number>();
      for (const file of uncovered) {
        const parts = file.split('/');
        if (parts.length > 1) {
          const dir = parts.slice(0, 2).join('/');
          subDirCounts.set(dir, (subDirCounts.get(dir) ?? 0) + 1);
        }
      }
      for (const [dir, count] of subDirCounts) {
        if (count >= SUBDIR_THRESHOLD) {
          const pkgId = `pkg:dir:${dir}`;
          const name = dir.split('/').pop() ?? dir;
          const pkg: ArchPackage = { id: pkgId, name, path: dir, source: 'directory', updatedAt: Date.now() };
          directoryPackages.push(pkg);
          for (const file of uncovered) {
            if (file.startsWith(dir + '/') && !filePackageMap.has(file)) {
              filePackageMap.set(file, pkgId);
            }
          }
        }
      }
    }

    const allPackages = [...manifestPackages, ...directoryPackages];

    // ── 5. Detect layers ───────────────────────────────────────────────────────
    log('architecture: detecting layers');
    const layerAssignments: FileLayerAssignment[] = [];
    const fileLayerMap = new Map<string, FileLayerAssignment>();

    if (this.config.architectureLayers !== undefined || this.config.enableArchitecture) {
      const assignments = await detectAllLayers(allFiles, this.projectRoot, this.config.architectureLayers);
      for (const a of assignments) {
        layerAssignments.push(a);
        fileLayerMap.set(a.filePath, a);
      }
    }

    const allLayers = buildArchLayers(layerAssignments, this.config.architectureLayers);

    // ── 6. Roll up package dependencies from import edges ─────────────────────
    log('architecture: rolling up package dependencies');
    const importPairs = this.db.getFileImportPairs();
    const pkgDepCounts = new Map<string, Map<string, { count: number; files: Array<{ from: string; to: string }> }>>();

    for (const { sourceFile, targetFile } of importPairs) {
      const sourcePkg = filePackageMap.get(sourceFile);
      const targetPkg = filePackageMap.get(targetFile);
      if (!sourcePkg || !targetPkg || sourcePkg === targetPkg) continue;

      if (!pkgDepCounts.has(sourcePkg)) pkgDepCounts.set(sourcePkg, new Map());
      const inner = pkgDepCounts.get(sourcePkg)!;
      if (!inner.has(targetPkg)) inner.set(targetPkg, { count: 0, files: [] });
      const entry = inner.get(targetPkg)!;
      entry.count++;
      if (entry.files.length < 5) entry.files.push({ from: sourceFile, to: targetFile });
    }

    const packageDeps: ArchPackageDep[] = [];
    for (const [sourcePkg, targets] of pkgDepCounts) {
      for (const [targetPkg, { count, files }] of targets) {
        packageDeps.push({ sourcePkg, targetPkg, depCount: count, files });
      }
    }

    // ── 7. Roll up layer dependencies ─────────────────────────────────────────
    const layerDepCounts = new Map<string, Map<string, number>>();
    for (const dep of packageDeps) {
      const srcFile = [...filePackageMap.entries()].find(([, pkgId]) => pkgId === dep.sourcePkg)?.[0];
      const tgtFile = [...filePackageMap.entries()].find(([, pkgId]) => pkgId === dep.targetPkg)?.[0];
      const srcLayer = srcFile ? fileLayerMap.get(srcFile)?.layerName : undefined;
      const tgtLayer = tgtFile ? fileLayerMap.get(tgtFile)?.layerName : undefined;
      if (!srcLayer || !tgtLayer || srcLayer === tgtLayer) continue;
      const srcLayerId = `layer:${srcLayer}`;
      const tgtLayerId = `layer:${tgtLayer}`;
      if (!layerDepCounts.has(srcLayerId)) layerDepCounts.set(srcLayerId, new Map());
      const inner = layerDepCounts.get(srcLayerId)!;
      inner.set(tgtLayerId, (inner.get(tgtLayerId) ?? 0) + dep.depCount);
    }

    const layerDeps: ArchLayerDep[] = [];
    for (const [srcLayer, targets] of layerDepCounts) {
      for (const [tgtLayer, count] of targets) {
        layerDeps.push({ sourceLayer: srcLayer, targetLayer: tgtLayer, depCount: count });
      }
    }

    // ── 8. Compute coupling metrics ────────────────────────────────────────────
    const afferentMap = new Map<string, number>(); // Ca: who depends on me
    const efferentMap = new Map<string, number>(); // Ce: who I depend on
    for (const dep of packageDeps) {
      efferentMap.set(dep.sourcePkg, (efferentMap.get(dep.sourcePkg) ?? 0) + 1);
      afferentMap.set(dep.targetPkg, (afferentMap.get(dep.targetPkg) ?? 0) + 1);
    }
    const coupling: ArchCoupling[] = allPackages.map(pkg => {
      const ca = afferentMap.get(pkg.id) ?? 0;
      const ce = efferentMap.get(pkg.id) ?? 0;
      const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
      return { packageId: pkg.id, afferent: ca, efferent: ce, instability, updatedAt: Date.now() };
    });

    // ── 9. Persist to DB ───────────────────────────────────────────────────────
    log('architecture: persisting to database');
    this.db.clearArchitecture();

    for (const pkg of allPackages) this.db.upsertArchPackage(pkg);
    for (const layer of allLayers) this.db.upsertArchLayer(layer);

    for (const [filePath, pkgId] of filePackageMap) this.db.upsertArchFilePackage(filePath, pkgId);
    for (const a of layerAssignments) {
      this.db.upsertArchFileLayer(a.filePath, `layer:${a.layerName}`, a.confidence, a.matchedPattern);
    }

    for (const dep of packageDeps) {
      this.db.upsertArchPackageDep(dep.sourcePkg, dep.targetPkg, dep.depCount, dep.files);
    }
    for (const dep of layerDeps) {
      this.db.upsertArchLayerDep(dep.sourceLayer, dep.targetLayer, dep.depCount);
    }
    for (const c of coupling) this.db.upsertArchCoupling(c);

    // Build return value
    const filePackages: Record<string, string[]> = {};
    for (const [filePath, pkgId] of filePackageMap) {
      if (!filePackages[filePath]) filePackages[filePath] = [];
      filePackages[filePath].push(pkgId);
    }

    const fileLayers: Record<string, Array<{ layerId: string; confidence: number; matchedPattern: string }>> = {};
    for (const a of layerAssignments) {
      fileLayers[a.filePath] = [{ layerId: `layer:${a.layerName}`, confidence: a.confidence, matchedPattern: a.matchedPattern }];
    }

    return { packages: allPackages, layers: allLayers, packageDeps, layerDeps, coupling, filePackages, fileLayers };
  }
}
