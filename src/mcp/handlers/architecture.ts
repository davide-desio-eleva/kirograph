import * as fs from 'fs';
import * as path from 'path';
import KiroGraph from '../../index';
import { parseAllManifests } from '../../architecture/manifest/index';
import { clampLimit } from './utils';

export async function handleArchitecture(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_architecture': {
      if (!cg.isArchitectureEnabled()) {
        return 'Architecture analysis is disabled. Set enableArchitecture=true in .kirograph/config.json and re-index.';
      }
      const level = (args.level as string) ?? 'both';
      const includeFiles = args.includeFiles === true;
      const arch = cg.getArchitecture();

      const lines: string[] = ['# Architecture'];

      if ((level === 'packages' || level === 'both') && arch.packages.length > 0) {
        lines.push('\n## Packages');
        for (const pkg of arch.packages) {
          const meta = [pkg.language, pkg.version].filter(Boolean).join(', ');
          lines.push(`- **${pkg.name}** (${pkg.path}) [${pkg.source}${meta ? ' · ' + meta : ''}]`);
        }
        if (arch.packageDeps.length > 0) {
          lines.push('\n## Package Dependencies');
          for (const dep of arch.packageDeps) {
            const src = arch.packages.find(p => p.id === dep.sourcePkg)?.name ?? dep.sourcePkg;
            const tgt = arch.packages.find(p => p.id === dep.targetPkg)?.name ?? dep.targetPkg;
            lines.push(`- ${src} → ${tgt} (${dep.depCount} import${dep.depCount !== 1 ? 's' : ''})`);
          }
        }
      }

      if ((level === 'layers' || level === 'both') && arch.layers.length > 0) {
        lines.push('\n## Layers');
        for (const layer of arch.layers) {
          const fileCount = Object.values(arch.fileLayers).filter(fl => fl.some(l => l.layerId === layer.id)).length;
          lines.push(`- **${layer.name}** [${layer.source}] — ${fileCount} file${fileCount !== 1 ? 's' : ''}`);
        }
        if (arch.layerDeps.length > 0) {
          lines.push('\n## Layer Dependencies');
          for (const dep of arch.layerDeps) {
            const src = dep.sourceLayer.replace('layer:', '');
            const tgt = dep.targetLayer.replace('layer:', '');
            lines.push(`- ${src} → ${tgt} (${dep.depCount})`);
          }
        }
      }

      if (includeFiles && (level === 'packages' || level === 'both')) {
        lines.push('\n## File → Package');
        for (const [file, pkgIds] of Object.entries(arch.filePackages).slice(0, 50)) {
          const names = pkgIds.map(id => arch.packages.find(p => p.id === id)?.name ?? id).join(', ');
          lines.push(`- ${file}: ${names}`);
        }
        if (Object.keys(arch.filePackages).length > 50) lines.push('  …(truncated)');
      }

      if (arch.packages.length === 0 && arch.layers.length === 0) {
        return 'No architecture data found. Run `kirograph index` with enableArchitecture=true.';
      }

      return lines.join('\n');
    }

    case 'kirograph_coupling': {
      if (!cg.isArchitectureEnabled()) {
        return 'Architecture analysis is disabled. Set enableArchitecture=true in .kirograph/config.json and re-index.';
      }
      const sortBy = (args.sortBy as string) ?? 'instability';
      const limit = clampLimit(args.limit as number | undefined, 20);
      const arch = cg.getArchitecture();

      if (arch.coupling.length === 0) {
        return 'No coupling data. Run `kirograph index` with enableArchitecture=true.';
      }

      const sorted = [...arch.coupling].sort((a, b) => {
        if (sortBy === 'afferent') return b.afferent - a.afferent;
        if (sortBy === 'efferent') return b.efferent - a.efferent;
        return b.instability - a.instability;
      }).slice(0, limit);

      const lines = [
        `Coupling Metrics (sorted by ${sortBy}):`,
        '',
        'Package                          Ca    Ce    I',
        '─'.repeat(52),
      ];

      for (const c of sorted) {
        const pkg = arch.packages.find(p => p.id === c.packageId);
        const name = (pkg?.name ?? c.packageId).slice(0, 32).padEnd(32);
        const ca = String(c.afferent).padStart(4);
        const ce = String(c.efferent).padStart(4);
        const inst = c.instability.toFixed(2).padStart(5);
        lines.push(`${name}  ${ca}  ${ce}  ${inst}`);
      }

      lines.push('', 'Ca=afferent (depended on by), Ce=efferent (depends on), I=instability (Ce/(Ca+Ce))');
      return lines.join('\n');
    }

    case 'kirograph_package': {
      if (!cg.isArchitectureEnabled()) {
        return 'Architecture analysis is disabled. Set enableArchitecture=true in .kirograph/config.json and re-index.';
      }
      const query = (args.package as string).toLowerCase();
      const includeFiles = args.includeFiles !== false;
      const arch = cg.getArchitecture();

      const pkg = arch.packages.find(p =>
        p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)
      );
      if (!pkg) return `Package "${args.package}" not found. Use kirograph_architecture to list all packages.`;

      const lines = [
        `## Package: ${pkg.name}`,
        `Path: ${pkg.path}`,
        `Source: ${pkg.source}${pkg.manifestPath ? ` (${pkg.manifestPath})` : ''}`,
        ...(pkg.version ? [`Version: ${pkg.version}`] : []),
        ...(pkg.language ? [`Language: ${pkg.language}`] : []),
      ];

      const deps = arch.packageDeps.filter(d => d.sourcePkg === pkg.id);
      const dependents = arch.packageDeps.filter(d => d.targetPkg === pkg.id);
      const coupling = arch.coupling.find(c => c.packageId === pkg.id);

      if (coupling) {
        lines.push('', `Coupling: Ca=${coupling.afferent} Ce=${coupling.efferent} I=${coupling.instability.toFixed(2)}`);
      }

      if (deps.length > 0) {
        lines.push('', `Depends on (${deps.length}):`);
        for (const dep of deps) {
          const name = arch.packages.find(p => p.id === dep.targetPkg)?.name ?? dep.targetPkg;
          lines.push(`  → ${name} (${dep.depCount} import${dep.depCount !== 1 ? 's' : ''})`);
        }
      }

      if (dependents.length > 0) {
        lines.push('', `Depended on by (${dependents.length}):`);
        for (const dep of dependents) {
          const name = arch.packages.find(p => p.id === dep.sourcePkg)?.name ?? dep.sourcePkg;
          lines.push(`  ← ${name} (${dep.depCount} import${dep.depCount !== 1 ? 's' : ''})`);
        }
      }

      if (pkg.externalDeps && pkg.externalDeps.length > 0) {
        lines.push('', `External deps (${pkg.externalDeps.length}): ${pkg.externalDeps.slice(0, 10).join(', ')}${pkg.externalDeps.length > 10 ? '…' : ''}`);
      }

      if (includeFiles) {
        const files = Object.entries(arch.filePackages)
          .filter(([, ids]) => ids.includes(pkg.id))
          .map(([f]) => f)
          .sort();
        if (files.length > 0) {
          lines.push('', `Files (${files.length}):`);
          for (const f of files.slice(0, 30)) lines.push(`  ${f}`);
          if (files.length > 30) lines.push(`  …and ${files.length - 30} more`);
        }
      }

      return lines.join('\n');
    }

    case 'kirograph_communities': {
      const { detectCommunities } = await import('../../graph/communities');
      const db = cg.getDatabase();
      const result = detectCommunities(db, {
        resolution: (args.resolution as number) ?? 1.0,
      });

      if (result.communities.length === 0) return 'No communities detected. The graph may be too small or have no edges.';

      const limit = Math.min((args.limit as number) ?? 15, result.communities.length);
      const lines = [
        `## Communities (${result.communities.length} detected, modularity: ${result.modularity.toFixed(3)})`,
        `Graph: ${result.totalNodes} nodes, ${result.totalEdges} edges`,
        '',
      ];

      for (const c of result.communities.slice(0, limit)) {
        lines.push(`### ${c.label} (${c.memberCount} symbols)`);
        lines.push(`- Directory: \`${c.dominantDirectory}\``);
        lines.push(`- Language: ${c.dominantLanguage}`);
        lines.push(`- Inter-community edges: ${c.interCommunityEdges}`);
        lines.push(`- Top members:`);
        for (const m of c.members.slice(0, 8)) {
          lines.push(`  - ${m.kind} \`${m.name}\` — ${m.filePath}`);
        }
        if (c.memberCount > 8) lines.push(`  - …and ${c.memberCount - 8} more`);
        lines.push('');
      }

      return lines.join('\n');
    }

    case 'kirograph_manifest': {
      const projectRoot = cg.getProjectRoot();
      const packages = await parseAllManifests(projectRoot);

      // Read license fields from manifest files for packages that have them
      const licenseMap = new Map<string, string>();
      for (const pkg of packages) {
        if (!pkg.manifestPath) continue;
        const absManifest = path.join(projectRoot, pkg.manifestPath);
        try {
          const basename = path.basename(absManifest);
          if (basename === 'package.json') {
            const raw = JSON.parse(fs.readFileSync(absManifest, 'utf8')) as Record<string, unknown>;
            const lic = raw.license;
            if (typeof lic === 'string') licenseMap.set(pkg.id, lic);
          } else if (basename === 'Cargo.toml') {
            const content = fs.readFileSync(absManifest, 'utf8');
            const m = content.match(/^\s*license\s*=\s*"([^"]+)"/m);
            if (m) licenseMap.set(pkg.id, m[1]);
          } else if (basename === 'pyproject.toml') {
            const content = fs.readFileSync(absManifest, 'utf8');
            const m = content.match(/^\s*license\s*=\s*"([^"]+)"/m);
            if (m) licenseMap.set(pkg.id, m[1]);
          }
        } catch {
          // ignore read errors
        }
      }

      // Filter by ecosystem if requested
      const ecosystemFilter = (args.ecosystem as string | undefined)?.toLowerCase();
      let filtered = ecosystemFilter
        ? packages.filter(p => p.language?.toLowerCase().includes(ecosystemFilter) || p.source === 'manifest' && p.manifestPath?.toLowerCase().includes(ecosystemFilter))
        : packages;

      // Drill into a single package
      const packageQuery = (args.package as string | undefined)?.toLowerCase();
      if (packageQuery) {
        const pkg = filtered.find(p =>
          p.name.toLowerCase().includes(packageQuery) || p.path.toLowerCase().includes(packageQuery) || p.id.toLowerCase().includes(packageQuery)
        );
        if (!pkg) return `Package "${args.package}" not found. Use kirograph_manifest (no args) to list all packages.`;

        const lines = [
          `## ${pkg.name}`,
          `ID: ${pkg.id}`,
          `Path: ${pkg.path}`,
          `Source: ${pkg.source}${pkg.manifestPath ? ` (${pkg.manifestPath})` : ''}`,
          ...(pkg.version ? [`Version: ${pkg.version}`] : []),
          ...(pkg.language ? [`Language: ${pkg.language}`] : []),
          ...(licenseMap.has(pkg.id) ? [`License: ${licenseMap.get(pkg.id)}`] : []),
        ];

        if (pkg.externalDeps && pkg.externalDeps.length > 0) {
          lines.push('', `External deps (${pkg.externalDeps.length}):`);
          for (const dep of pkg.externalDeps) lines.push(`  - ${dep}`);
        }
        return lines.join('\n');
      }

      // Version drift: packages declared in multiple places with differing versions
      if (args.showDrift) {
        const byName = new Map<string, Array<{ id: string; version?: string; path: string }>>();
        for (const pkg of filtered) {
          const key = pkg.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key)!.push({ id: pkg.id, version: pkg.version, path: pkg.path });
        }
        const drifted = [...byName.entries()].filter(([, entries]) => {
          const versions = new Set(entries.map(e => e.version).filter(Boolean));
          return entries.length > 1 && versions.size > 1;
        });
        if (drifted.length === 0) return 'No version drift detected across packages.';
        const lines = ['## Version Drift', ''];
        for (const [name, entries] of drifted) {
          lines.push(`**${name}**`);
          for (const e of entries) lines.push(`  - ${e.path}: ${e.version ?? '(no version)'}`);
        }
        return lines.join('\n');
      }

      // Summary table
      if (filtered.length === 0) return 'No manifest packages found. Run `kirograph index` or check your project root.';

      const byLang = new Map<string, typeof filtered>();
      for (const pkg of filtered) {
        const lang = pkg.language ?? 'unknown';
        if (!byLang.has(lang)) byLang.set(lang, []);
        byLang.get(lang)!.push(pkg);
      }

      const lines: string[] = [`## Workspace Manifest (${filtered.length} package${filtered.length !== 1 ? 's' : ''})`, ''];
      for (const [lang, pkgs] of [...byLang.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`### ${lang} (${pkgs.length})`);
        for (const pkg of pkgs) {
          const ver = pkg.version ? ` v${pkg.version}` : '';
          const deps = pkg.externalDeps ? ` · ${pkg.externalDeps.length} deps` : '';
          const lic = licenseMap.has(pkg.id) ? ` · ${licenseMap.get(pkg.id)}` : '';
          lines.push(`- **${pkg.name}**${ver} \`${pkg.path}\`${deps}${lic}`);
        }
        lines.push('');
      }

      lines.push(`Tip: pass package=<name> for full dep list, showDrift=true for version conflicts.`);
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
