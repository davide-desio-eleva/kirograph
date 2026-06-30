import KiroGraph from '../../index';
import { listTrackedBranches, branchDbPath, getCurrentGitBranch } from '../../core/branch-manager';

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export async function handleBranch(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  const projectRoot = cg.getProjectRoot();

  switch (toolName) {
    case 'kirograph_branch_list': {
      const currentBranch = getCurrentGitBranch(projectRoot);
      const branches = listTrackedBranches(projectRoot);

      const lines = [`## Tracked Branch Databases\n`];
      lines.push(`Current git branch: ${currentBranch}\n`);

      if (branches.length === 0) {
        lines.push('No branch databases found.');
        lines.push('\nTo add a branch snapshot, run:');
        lines.push('  kirograph branch add <branch-name>');
        return lines.join('\n');
      }

      lines.push(`${'Branch'.padEnd(40)}  ${'Size'.padEnd(10)}  Last Sync`);
      lines.push('-'.repeat(70));
      for (const b of branches) {
        const lastSync = new Date(b.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
        lines.push(`${b.name.padEnd(40)}  ${humanSize(b.sizeBytes).padEnd(10)}  ${lastSync}`);
      }
      lines.push(`\nTotal: ${branches.length} branch database(s)`);
      lines.push('\nTo add a new branch: kirograph branch add <branch-name>');
      return lines.join('\n');
    }

    case 'kirograph_branch_diff': {
      const branchA = args.branchA as string | undefined;
      const branchB = (args.branchB as string) ?? 'main';

      if (!branchA) return 'Error: branchA is required.';

      const pathA = branchDbPath(projectRoot, branchA);
      const pathB = branchDbPath(projectRoot, branchB);

      const fs = await import('fs');
      if (!fs.existsSync(pathA)) {
        return `Branch database for "${branchA}" not found at ${pathA}.\nUse kirograph branch add ${branchA} to create it.`;
      }
      if (!fs.existsSync(pathB)) {
        return `Branch database for "${branchB}" not found at ${pathB}.\nUse kirograph branch add ${branchB} to create it.`;
      }

      const { Database } = await import('node-sqlite3-wasm') as any;
      const rawDbA = new Database(pathA);
      const rowsA = rawDbA.all('SELECT id, name, kind, file_path, qualified_name FROM nodes', []) as Array<{
        id: string; name: string; kind: string; file_path: string; qualified_name: string;
      }>;
      rawDbA.close();

      const rawDbB = new Database(pathB);
      const rowsB = rawDbB.all('SELECT id, name, kind, file_path, qualified_name FROM nodes', []) as Array<{
        id: string; name: string; kind: string; file_path: string; qualified_name: string;
      }>;
      rawDbB.close();

      const mapA = new Map(rowsA.map(r => [r.id, r]));
      const mapB = new Map(rowsB.map(r => [r.id, r]));

      const onlyInA: typeof rowsA = [];
      const onlyInB: typeof rowsB = [];
      const changed: Array<{ a: typeof rowsA[0]; b: typeof rowsB[0] }> = [];

      for (const [id, nodeA] of mapA) {
        if (!mapB.has(id)) {
          onlyInA.push(nodeA);
        } else {
          const nodeB = mapB.get(id)!;
          if (nodeA.qualified_name !== nodeB.qualified_name) {
            changed.push({ a: nodeA, b: nodeB });
          }
        }
      }
      for (const [id, nodeB] of mapB) {
        if (!mapA.has(id)) onlyInB.push(nodeB);
      }

      const lines = [
        `## Branch Diff: ${branchA}  vs  ${branchB}\n`,
        `Added in ${branchA} (not in ${branchB}): ${onlyInA.length}`,
        `Removed from ${branchA} (in ${branchB} only): ${onlyInB.length}`,
        `Changed (different qualified_name): ${changed.length}`,
        '',
      ];

      if (onlyInA.length > 0) {
        lines.push(`### Added (${Math.min(onlyInA.length, 20)} shown):`);
        for (const n of onlyInA.slice(0, 20)) {
          lines.push(`  + [${n.kind}] \`${n.name}\` — ${n.file_path}`);
        }
        if (onlyInA.length > 20) lines.push(`  …and ${onlyInA.length - 20} more`);
        lines.push('');
      }

      if (onlyInB.length > 0) {
        lines.push(`### Removed (${Math.min(onlyInB.length, 20)} shown):`);
        for (const n of onlyInB.slice(0, 20)) {
          lines.push(`  - [${n.kind}] \`${n.name}\` — ${n.file_path}`);
        }
        if (onlyInB.length > 20) lines.push(`  …and ${onlyInB.length - 20} more`);
        lines.push('');
      }

      if (changed.length > 0) {
        lines.push(`### Changed (${Math.min(changed.length, 20)} shown):`);
        for (const { a, b } of changed.slice(0, 20)) {
          lines.push(`  ~ [${a.kind}] \`${a.name}\`: ${b.qualified_name} → ${a.qualified_name}`);
        }
        if (changed.length > 20) lines.push(`  …and ${changed.length - 20} more`);
      }

      return lines.join('\n');
    }

    case 'kirograph_branch_search': {
      const query = args.query as string | undefined;
      const branch = args.branch as string | undefined;
      const limitN = typeof args.limit === 'number' ? Math.max(1, Math.min(args.limit, 100)) : 20;

      if (!query) return 'Error: query is required.';
      if (!branch) return 'Error: branch is required.';

      const dbPath = branchDbPath(projectRoot, branch);
      const fs = await import('fs');
      if (!fs.existsSync(dbPath)) {
        return `Branch database for "${branch}" not found at ${dbPath}.\nUse kirograph branch add ${branch} to create it.`;
      }

      const { Database } = await import('node-sqlite3-wasm') as any;
      const rawDb = new Database(dbPath);
      const pattern = `%${query}%`;
      const rows = rawDb.all(
        'SELECT name, kind, file_path, start_line FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? LIMIT ?',
        [pattern, pattern, limitN]
      ) as Array<{ name: string; kind: string; file_path: string; start_line: number }>;
      rawDb.close();

      if (rows.length === 0) return `No symbols matching "${query}" found in branch "${branch}".`;

      const lines = [`## Search results for "${query}" in branch "${branch}" (${rows.length} found)\n`];
      for (const r of rows) {
        lines.push(`  [${r.kind}] \`${r.name}\` — ${r.file_path}:${r.start_line}`);
      }
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
