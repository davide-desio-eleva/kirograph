import KiroGraph from '../../index';
import { clampLimit, mapKind, truncate } from './utils';

export async function handleCodeHealth(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_dead_code': {
      const limit = clampLimit(args.limit as number | undefined, 50);
      const dead = cg.findDeadCode(limit);
      if (dead.length === 0) return 'No dead code detected.';
      return `Potential dead code (${dead.length} unexported symbols with no incoming references):\n` +
        dead.map(n => `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');
    }

    case 'kirograph_circular_deps': {
      const cycles = cg.findCircularDependencies();
      if (cycles.length === 0) return 'No circular dependencies found.';
      return `Found ${cycles.length} circular dependency cycle(s):\n` +
        cycles.map((cycle, i) => `Cycle ${i + 1}: ${cycle.join(' → ')}`).join('\n');
    }

    case 'kirograph_path': {
      const fromResults = cg.searchNodes(args.from as string, undefined, 3);
      const toResults = cg.searchNodes(args.to as string, undefined, 3);
      if (fromResults.length === 0) return `Symbol "${args.from}" not found in index.`;
      if (toResults.length === 0) return `Symbol "${args.to}" not found in index.`;
      const fromNode = fromResults[0].node;
      const toNode = toResults[0].node;
      const pathNodes = await cg.findPath(fromNode.id, toNode.id);
      if (pathNodes.length === 0) return `No path found between \`${fromNode.name}\` and \`${toNode.name}\`.`;
      return `Path from \`${fromNode.name}\` to \`${toNode.name}\` (${pathNodes.length} nodes):\n` +
        pathNodes.map((n, i) => `${i + 1}. ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');
    }

    case 'kirograph_type_hierarchy': {
      const results = cg.searchNodes(args.symbol as string, undefined, 5);
      if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
      const node = results[0].node;
      const direction = (args.direction as 'up' | 'down' | 'both') ?? 'both';
      const hierarchy = cg.getTypeHierarchy(node.id, direction);
      if (hierarchy.length === 0) return `No type hierarchy found for \`${node.name}\`.`;
      return `Type hierarchy for \`${node.name}\` (direction: ${direction}):\n` +
        hierarchy.map(n => `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');
    }

    case 'kirograph_hotspots': {
      const limit = clampLimit(args.limit as number | undefined, 20);
      const hotspots = cg.findHotspots(limit);
      if (hotspots.length === 0) return 'No symbols found in index.';
      const lines = [`Top ${hotspots.length} most-connected symbols (by edge degree):\n`];
      for (const n of hotspots) {
        lines.push(`${mapKind(n.kind)} \`${n.name}\` — degree ${n.degree} (in: ${n.inDegree}, out: ${n.outDegree})`);
        lines.push(`  File: ${n.filePath}:${n.startLine}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_surprising': {
      const limit = clampLimit(args.limit as number | undefined, 20);
      const connections = cg.findSurprisingConnections(limit);
      if (connections.length === 0) return 'No surprising cross-file connections found.';
      const lines = [`Top ${connections.length} surprising cross-file connections:\n`];
      for (const c of connections) {
        lines.push(`${mapKind(c.source.kind)} \`${c.source.name}\` ${c.kind}→ ${mapKind(c.target.kind)} \`${c.target.name}\` (score: ${c.score.toFixed(2)})`);
        lines.push(`  ${c.source.filePath} → ${c.target.filePath}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_diff': {
      const sm = cg.createSnapshotManager();
      const snapshot = args.snapshot
        ? sm.load(args.snapshot as string)
        : sm.loadLatest();
      if (!snapshot) {
        return args.snapshot
          ? `Snapshot "${args.snapshot}" not found. Use \`kirograph snapshot list\` to see available snapshots.`
          : 'No snapshots found. Run `kirograph snapshot` to save one first.';
      }
      const diff = sm.diff(snapshot, sm.currentSnapshot());
      const fromDate = new Date(diff.from.timestamp).toISOString().slice(0, 19).replace('T', ' ');
      const lines = [
        `Graph diff: "${diff.from.label}" (${fromDate}) → current`,
        ``,
        `Symbols: +${diff.addedNodes.length} added, -${diff.removedNodes.length} removed`,
        `Edges:   +${diff.addedEdges.length} added, -${diff.removedEdges.length} removed`,
      ];
      if (diff.addedNodes.length > 0) {
        lines.push(`\n## Added symbols (${diff.addedNodes.length})`);
        for (const n of diff.addedNodes.slice(0, 30)) {
          lines.push(`+ ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}`);
        }
        if (diff.addedNodes.length > 30) lines.push(`  …and ${diff.addedNodes.length - 30} more`);
      }
      if (diff.removedNodes.length > 0) {
        lines.push(`\n## Removed symbols (${diff.removedNodes.length})`);
        for (const n of diff.removedNodes.slice(0, 30)) {
          lines.push(`- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}`);
        }
        if (diff.removedNodes.length > 30) lines.push(`  …and ${diff.removedNodes.length - 30} more`);
      }
      return lines.join('\n');
    }

    case 'kirograph_snapshot_save': {
      const sm = cg.createSnapshotManager();
      const snapshot = sm.save(args.label as string | undefined);
      return `Snapshot saved: "${snapshot.label}" — ${snapshot.nodeCount} symbols, ${snapshot.edgeCount} edges`;
    }

    case 'kirograph_snapshot_list': {
      const sm = cg.createSnapshotManager();
      const snapshots = sm.list();
      if (snapshots.length === 0) return 'No snapshots yet. Use kirograph_snapshot_save to save one first.';
      const lines = [`Saved snapshots (${snapshots.length}):\n`];
      for (const s of snapshots) {
        const date = new Date(s.timestamp).toISOString().slice(0, 19).replace('T', ' ');
        lines.push(`- ${s.label}  (${date}, ${s.nodeCount} symbols, ${s.edgeCount} edges)`);
      }
      return lines.join('\n');
    }

    case 'kirograph_module_api': {
      const rawDb = cg.getDatabase().getRawDb();
      const pathArg = args.path as string | undefined;
      let rows: any[];
      if (pathArg) {
        const exact = pathArg.endsWith('.ts') || pathArg.endsWith('.js') || pathArg.includes('.');
        rows = exact
          ? rawDb.all(`SELECT * FROM nodes WHERE is_exported = 1 AND file_path = ? ORDER BY kind, name`, [pathArg])
          : rawDb.all(`SELECT * FROM nodes WHERE is_exported = 1 AND file_path LIKE ? ORDER BY kind, name`, [pathArg.replace(/\/$/, '') + '/%']);
      } else {
        rows = rawDb.all(`SELECT * FROM nodes WHERE is_exported = 1 ORDER BY file_path, kind, name`);
      }
      if (rows.length === 0) return pathArg ? `No exported symbols found in "${pathArg}".` : 'No exported symbols found.';
      const limit = clampLimit(args.limit as number | undefined, 100);
      const limited = rows.slice(0, limit);
      const lines = [`Exported API surface${pathArg ? ` for "${pathArg}"` : ''} (${limited.length}${rows.length > limit ? `/${rows.length}` : ''} symbols):\n`];
      let lastFile = '';
      for (const r of limited) {
        if (r.file_path !== lastFile) { lines.push(`\n${r.file_path}`); lastFile = r.file_path; }
        const sig = r.signature ? `  ${r.signature}` : '';
        lines.push(`  ${mapKind(r.kind)} \`${r.name}\`${sig}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_rename_preview': {
      const results = cg.searchNodes(args.symbol as string, undefined, 5);
      if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
      const node = results[0].node;
      const rawDb = cg.getDatabase().getRawDb();
      const refs = rawDb.all(
        `SELECT n.name, n.kind, n.file_path, n.start_line, e.kind as edge_kind
         FROM edges e JOIN nodes n ON e.source = n.id
         WHERE e.target = ? AND e.kind != 'contains'
         ORDER BY n.file_path, n.start_line`,
        [node.id]
      );
      if (refs.length === 0) return `No references to \`${node.name}\` found. Safe to rename.`;
      const lines = [
        `Rename preview for \`${node.name}\` (${mapKind(node.kind)})`,
        `Defined in: ${node.filePath}:${node.startLine}`,
        `\n${refs.length} reference site(s):\n`,
      ];
      let lastFile = '';
      for (const r of refs) {
        if (r.file_path !== lastFile) { lines.push(`\n${r.file_path}`); lastFile = r.file_path; }
        lines.push(`  ${mapKind(r.kind)} \`${r.name}\` (line ${r.start_line}, via ${r.edge_kind})`);
      }
      return lines.join('\n');
    }

    case 'kirograph_doc_coverage': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 50);
      const rows = rawDb.all(
        `SELECT kind, name, file_path, start_line FROM nodes
         WHERE is_exported = 1 AND (docstring IS NULL OR docstring = '')
         AND kind IN ('function','method','class','interface','type_alias')
         ORDER BY file_path, start_line LIMIT ?`,
        [limitN]
      );
      if (rows.length === 0) return 'All exported symbols have docstrings.';
      const lines = [`Exported symbols missing docstrings (${rows.length}):\n`];
      let lastFile = '';
      for (const r of rows) {
        if (r.file_path !== lastFile) { lines.push(`\n${r.file_path}`); lastFile = r.file_path; }
        lines.push(`  ${mapKind(r.kind)} \`${r.name}\` — line ${r.start_line}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_god_class': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 20);
      const rows = rawDb.all(
        `SELECT n.name, n.file_path, n.start_line, COUNT(e.target) as member_count
         FROM nodes n JOIN edges e ON e.source = n.id AND e.kind = 'contains'
         WHERE n.kind IN ('class','interface')
         GROUP BY n.id HAVING member_count > 0
         ORDER BY member_count DESC LIMIT ?`,
        [limitN]
      );
      if (rows.length === 0) return 'No class definitions found.';
      const threshold = (args.threshold as number) ?? 10;
      const gods = rows.filter((r: any) => r.member_count >= threshold);
      const lines = [
        `Classes ranked by member count (threshold: ${threshold}):\n`,
        ...rows.map((r: any) => `${r.member_count >= threshold ? '⚠ ' : '  '}${r.member_count.toString().padStart(4)} members  \`${r.name}\` — ${r.file_path}:${r.start_line}`),
      ];
      if (gods.length > 0) lines.unshift(`${gods.length} god class(es) found (≥${threshold} members).\n`);
      return lines.join('\n');
    }

    case 'kirograph_inheritance_depth': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 20);
      // BFS from root classes down the extends/implements hierarchy
      const allNodes = rawDb.all(
        `SELECT id, name, file_path, start_line FROM nodes WHERE kind IN ('class','interface')`,
        []
      );
      const childToParents: Map<string, string[]> = new Map();
      const extEdges = rawDb.all(
        `SELECT source, target FROM edges WHERE kind IN ('extends','implements')`,
        []
      );
      for (const e of extEdges) {
        if (!childToParents.has(e.source)) childToParents.set(e.source, []);
        childToParents.get(e.source)!.push(e.target);
      }
      // Compute depth per node via memoized DFS
      const depths = new Map<string, number>();
      function depth(id: string): number {
        if (depths.has(id)) return depths.get(id)!;
        const parents = childToParents.get(id) ?? [];
        const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depth));
        depths.set(id, d);
        return d;
      }
      for (const n of allNodes) depth(n.id);
      const sorted = allNodes
        .map((n: any) => ({ ...n, depth: depths.get(n.id) ?? 0 }))
        .filter((n: any) => n.depth > 0)
        .sort((a: any, b: any) => b.depth - a.depth)
        .slice(0, limitN);
      if (sorted.length === 0) return 'No inheritance hierarchies found.';
      return `Deepest inheritance chains (${sorted.length}):\n\n` +
        sorted.map((n: any) => `  depth ${n.depth}  \`${n.name}\` — ${n.file_path}:${n.start_line}`).join('\n');
    }

    case 'kirograph_recursion': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 30);
      // Direct recursion: node calls itself
      const direct = rawDb.all(
        `SELECT n.name, n.kind, n.file_path, n.start_line FROM nodes n
         JOIN edges e ON e.source = n.id AND e.target = n.id AND e.kind = 'calls'
         WHERE n.kind IN ('function','method')
         ORDER BY n.file_path, n.start_line LIMIT ?`,
        [Math.ceil(limitN / 2)]
      );
      // Mutual recursion via SCCs on call graph (simple 2-cycle detection)
      const mutual = rawDb.all(
        `SELECT n1.name as a, n2.name as b, n1.file_path, n1.start_line FROM edges e1
         JOIN edges e2 ON e1.target = e2.source AND e2.target = e1.source
         JOIN nodes n1 ON n1.id = e1.source JOIN nodes n2 ON n2.id = e2.source
         WHERE e1.kind = 'calls' AND e2.kind = 'calls' AND e1.source < e2.source
         ORDER BY n1.name LIMIT ?`,
        [Math.ceil(limitN / 2)]
      );
      if (direct.length === 0 && mutual.length === 0) return 'No recursive functions detected.';
      const lines = [];
      if (direct.length > 0) {
        lines.push(`Direct recursion (${direct.length}):\n`);
        for (const r of direct) lines.push(`  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`);
      }
      if (mutual.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Mutual recursion (${mutual.length} pairs):\n`);
        for (const r of mutual) lines.push(`  \`${r.a}\` ↔ \`${r.b}\` — ${r.file_path}:${r.start_line}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_largest': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 30);
      const rows = rawDb.all(
        `SELECT name, kind, file_path, start_line, (end_line - start_line + 1) as loc
         FROM nodes WHERE end_line IS NOT NULL AND end_line > start_line
         ORDER BY loc DESC LIMIT ?`,
        [limitN]
      );
      if (rows.length === 0) return 'No symbol size data available.';
      return `Largest symbols by lines of code (${rows.length}):\n\n` +
        rows.map((r: any) => `  ${r.loc.toString().padStart(5)} LOC  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`).join('\n');
    }

    case 'kirograph_rank': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 30);
      const by = (args.by as string) ?? 'fan-in';
      let rows: any[];
      if (by === 'fan-out') {
        rows = rawDb.all(
          `SELECT n.name, n.kind, n.file_path, n.start_line, COUNT(e.target) as score
           FROM nodes n JOIN edges e ON e.source = n.id AND e.kind = 'calls'
           GROUP BY n.id ORDER BY score DESC LIMIT ?`,
          [limitN]
        );
      } else {
        rows = rawDb.all(
          `SELECT n.name, n.kind, n.file_path, n.start_line, COUNT(e.source) as score
           FROM nodes n JOIN edges e ON e.target = n.id AND e.kind IN ('calls','imports')
           GROUP BY n.id ORDER BY score DESC LIMIT ?`,
          [limitN]
        );
      }
      if (rows.length === 0) return `No ${by} data available.`;
      return `Symbols ranked by ${by} (${rows.length}):\n\n` +
        rows.map((r: any) => `  ${r.score.toString().padStart(5)}  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`).join('\n');
    }

    case 'kirograph_distribution': {
      const rawDb = cg.getDatabase().getRawDb();
      const pathArg = args.path as string | undefined;
      let rows: any[];
      if (pathArg) {
        rows = rawDb.all(
          `SELECT kind, COUNT(*) as count FROM nodes WHERE file_path LIKE ?
           GROUP BY kind ORDER BY count DESC`,
          [pathArg.replace(/\/$/, '') + '%']
        );
      } else {
        rows = rawDb.all(`SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind ORDER BY count DESC`, []);
      }
      if (rows.length === 0) return 'No symbols found.';
      const total = rows.reduce((s: number, r: any) => s + r.count, 0);
      const lines = [`Symbol distribution${pathArg ? ` in "${pathArg}"` : ''} (${total} total):\n`];
      for (const r of rows) {
        const pct = ((r.count / total) * 100).toFixed(1);
        lines.push(`  ${r.count.toString().padStart(6)}  (${pct.padStart(5)}%)  ${r.kind}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_annotations': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 50);
      const decorator = args.decorator as string | undefined;
      let rows: any[];
      if (decorator) {
        rows = rawDb.all(
          `SELECT name, kind, file_path, start_line, decorators FROM nodes
           WHERE decorators LIKE ? ORDER BY file_path, start_line LIMIT ?`,
          [`%${decorator}%`, limitN]
        );
      } else {
        // Histogram of decorators
        const all = rawDb.all(`SELECT decorators FROM nodes WHERE decorators IS NOT NULL AND decorators != '[]'`, []);
        const hist = new Map<string, number>();
        for (const r of all) {
          try {
            const decs: string[] = JSON.parse(r.decorators);
            for (const d of decs) hist.set(d, (hist.get(d) ?? 0) + 1);
          } catch { /* skip */ }
        }
        if (hist.size === 0) return 'No decorators/annotations found.';
        const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, limitN);
        return `Decorator/annotation histogram (${hist.size} unique):\n\n` +
          sorted.map(([d, n]) => `  ${n.toString().padStart(5)}  @${d}`).join('\n');
      }
      if (rows.length === 0) return `No symbols with decorator "${decorator}" found.`;
      return `Symbols with @${decorator} (${rows.length}):\n\n` +
        rows.map((r: any) => `  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`).join('\n');
    }

    case 'kirograph_session_start': {
      const sm = cg.createSnapshotManager();
      const snapshot = sm.save('session-baseline');
      return `Session baseline saved: ${snapshot.nodeCount} symbols, ${snapshot.edgeCount} edges.\nUse kirograph_session_end to see what changed.`;
    }

    case 'kirograph_session_end': {
      const sm = cg.createSnapshotManager();
      const snapshots = sm.list();
      const baseline = snapshots.find(s => s.label === 'session-baseline');
      if (!baseline) return 'No session baseline found. Run kirograph_session_start first.';
      const current = sm.save(`session-end-${Date.now()}`);
      const nodeDelta = current.nodeCount - baseline.nodeCount;
      const edgeDelta = current.edgeCount - baseline.edgeCount;
      const lines = [
        `Session delta (since ${new Date(baseline.timestamp).toISOString().slice(0, 19).replace('T', ' ')}):`,
        `  Symbols: ${baseline.nodeCount} → ${current.nodeCount} (${nodeDelta >= 0 ? '+' : ''}${nodeDelta})`,
        `  Edges:   ${baseline.edgeCount} → ${current.edgeCount} (${edgeDelta >= 0 ? '+' : ''}${edgeDelta})`,
      ];
      return lines.join('\n');
    }

    case 'kirograph_unused_imports': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 50);
      const rows = rawDb.all(
        `SELECT n.* FROM nodes n
         LEFT JOIN edges e ON e.source = n.id AND e.kind != 'contains'
         WHERE n.kind = 'import'
         GROUP BY n.id HAVING COUNT(e.id) = 0
         ORDER BY n.file_path, n.start_line LIMIT ?`,
        [limitN]
      );
      if (rows.length === 0) return 'No unused imports detected.';
      const lines = [`Unused imports (${rows.length}):\n`];
      let lastFile = '';
      for (const r of rows) {
        if (r.file_path !== lastFile) { lines.push(`\n${r.file_path}`); lastFile = r.file_path; }
        lines.push(`  ${mapKind(r.kind)} \`${r.name}\` — line ${r.start_line}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_gini': {
      const rawDb = cg.getDatabase().getRawDb();
      const metric = (args.metric as string) ?? 'loc';
      let values: number[];
      let rows: any[];

      if (metric === 'loc') {
        rows = rawDb.all(
          `SELECT name, kind, file_path, start_line, (end_line - start_line + 1) as val
           FROM nodes
           WHERE kind IN ('function','method') AND end_line IS NOT NULL AND end_line >= start_line
           ORDER BY val DESC`,
          []
        );
      } else if (metric === 'fan-out') {
        rows = rawDb.all(
          `SELECT n.name, n.kind, n.file_path, n.start_line, COUNT(e.target) as val
           FROM nodes n LEFT JOIN edges e ON e.source = n.id AND e.kind = 'calls'
           WHERE n.kind IN ('function','method')
           GROUP BY n.id ORDER BY val DESC`,
          []
        );
      } else {
        // fan-in
        rows = rawDb.all(
          `SELECT n.name, n.kind, n.file_path, n.start_line, COUNT(e.source) as val
           FROM nodes n LEFT JOIN edges e ON e.target = n.id AND e.kind IN ('calls','imports','references')
           WHERE n.kind IN ('function','method')
           GROUP BY n.id ORDER BY val DESC`,
          []
        );
      }

      if (rows.length < 2) return 'Not enough function/method nodes to compute Gini coefficient.';

      values = rows.map((r: any) => Number(r.val));
      const n = values.length;
      const sum = values.reduce((a, b) => a + b, 0);

      let gini = 0;
      if (sum > 0) {
        const sorted = [...values].sort((a, b) => a - b);
        const numerator = sorted.reduce((acc, x, i) => acc + (2 * (i + 1) - n - 1) * x, 0);
        gini = numerator / (n * sum);
      }

      const top5 = rows.slice(0, 5);
      const bottom5 = rows.slice(-5).reverse();

      const lines = [
        `Gini coefficient for ${metric} across ${n} function/method nodes: ${gini.toFixed(4)}`,
        `(0 = perfect equality, 1 = total inequality)\n`,
        `Top 5 by ${metric}:`,
        ...top5.map((r: any) => `  ${String(r.val).padStart(6)}  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`),
        `\nBottom 5 by ${metric}:`,
        ...bottom5.map((r: any) => `  ${String(r.val).padStart(6)}  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`),
      ];
      return lines.join('\n');
    }

    case 'kirograph_dependency_depth': {
      const rawDb = cg.getDatabase().getRawDb();
      const limitN = clampLimit(args.limit as number | undefined, 20);

      // Get all distinct file paths
      const fileRows = rawDb.all(`SELECT DISTINCT file_path FROM nodes ORDER BY file_path`, []);
      const files: string[] = fileRows.map((r: any) => r.file_path);
      if (files.length === 0) return 'No files found in index.';

      // Get file-level import edges (source file imports target file)
      const edgeRows = rawDb.all(
        `SELECT DISTINCT n1.file_path as src, n2.file_path as tgt
         FROM edges e
         JOIN nodes n1 ON n1.id = e.source
         JOIN nodes n2 ON n2.id = e.target
         WHERE e.kind = 'imports' AND n1.file_path != n2.file_path`,
        []
      );

      // Build adjacency + in-degree for Kahn's algorithm
      const outEdges = new Map<string, Set<string>>();
      const inDegree = new Map<string, number>();
      for (const f of files) { outEdges.set(f, new Set()); inDegree.set(f, 0); }
      for (const e of edgeRows) {
        outEdges.get(e.src)?.add(e.tgt);
        inDegree.set(e.tgt, (inDegree.get(e.tgt) ?? 0) + 1);
      }

      // Kahn's — assign levels (longest path from a root)
      const level = new Map<string, number>();
      const queue: string[] = [];
      for (const f of files) {
        if ((inDegree.get(f) ?? 0) === 0) { queue.push(f); level.set(f, 0); }
      }
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const curLevel = level.get(cur) ?? 0;
        for (const nb of (outEdges.get(cur) ?? [])) {
          const newLevel = curLevel + 1;
          if ((level.get(nb) ?? -1) < newLevel) level.set(nb, newLevel);
          const deg = (inDegree.get(nb) ?? 1) - 1;
          inDegree.set(nb, deg);
          if (deg === 0) queue.push(nb);
        }
      }

      const sorted = files
        .map(f => ({ file: f, depth: level.get(f) ?? 0 }))
        .sort((a, b) => b.depth - a.depth)
        .slice(0, limitN);

      const lines = [`File dependency depths (deepest first, limit ${limitN}):\n`];
      for (const { file, depth } of sorted) {
        const sample = rawDb.all(
          `SELECT name, kind FROM nodes WHERE file_path = ? AND kind IN ('function','class','interface','method') LIMIT 3`,
          [file]
        );
        const symbols = sample.map((r: any) => `\`${r.name}\``).join(', ');
        lines.push(`  depth ${String(depth).padStart(3)}  ${file}${symbols ? `  (${symbols})` : ''}`);
      }
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
