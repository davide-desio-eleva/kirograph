import KiroGraph from '../../index';
import { clampLimit, mapKind } from './utils';

export async function handleComplexity(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  const rawDb = cg.getDatabase().getRawDb();

  switch (toolName) {
    case 'kirograph_complexity': {
      const limitN = clampLimit(args.limit as number | undefined, 30);
      const metric = (args.metric as string) ?? 'cyclomatic';
      const col = metric === 'cognitive' ? 'complexity_cognitive'
        : metric === 'maintainability' ? 'maintainability_index'
        : 'complexity_cyclomatic';
      const order = metric === 'maintainability' ? 'ASC' : 'DESC';
      const threshold = (args.threshold as number) ?? (metric === 'maintainability' ? 50 : 10);

      const rows = rawDb.all(
        `SELECT name, kind, file_path, start_line, complexity_cyclomatic, complexity_cognitive,
                maintainability_index, nesting_depth, (end_line - start_line + 1) as loc
         FROM nodes WHERE ${col} IS NOT NULL AND kind IN ('function','method')
         ORDER BY ${col} ${order} LIMIT ?`,
        [limitN]
      );
      if (rows.length === 0) {
        return 'No complexity data found. Re-index with enableComplexity: true in .kirograph/config.json, then run `kirograph index`.';
      }
      const flagged = rows.filter((r: any) =>
        metric === 'maintainability' ? (r.maintainability_index ?? 100) <= threshold : (r[col] ?? 0) >= threshold
      );
      const lines = [
        `Symbols ranked by ${metric} complexity (${rows.length} shown${flagged.length > 0 ? `, ${flagged.length} exceeding threshold ${threshold}` : ''}):\n`,
      ];
      for (const r of rows) {
        const cc = r.complexity_cyclomatic ?? '—';
        const mi = r.maintainability_index !== null ? (r.maintainability_index as number).toFixed(1) : '—';
        const depth = r.nesting_depth ?? '—';
        const warn = flagged.includes(r) ? '⚠ ' : '  ';
        lines.push(`${warn}CC=${cc}  MI=${mi}  depth=${depth}  ${r.loc}LOC  ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_simplify_scan': {
      // Quality analysis of changed files — complexity + size on recently modified symbols
      const limitN = clampLimit(args.limit as number | undefined, 30);
      const thresholdCC = (args.thresholdCC as number) ?? 10;
      const thresholdMI = (args.thresholdMI as number) ?? 50;
      const thresholdLOC = (args.thresholdLOC as number) ?? 50;

      const rows = rawDb.all(
        `SELECT name, kind, file_path, start_line,
                complexity_cyclomatic, maintainability_index,
                nesting_depth, (end_line - start_line + 1) as loc
         FROM nodes WHERE kind IN ('function','method')
           AND (
             (complexity_cyclomatic IS NOT NULL AND complexity_cyclomatic >= ?)
             OR (maintainability_index IS NOT NULL AND maintainability_index <= ?)
             OR ((end_line - start_line + 1) >= ?)
           )
         ORDER BY complexity_cyclomatic DESC NULLS LAST LIMIT ?`,
        [thresholdCC, thresholdMI, thresholdLOC, limitN]
      );
      if (rows.length === 0) return 'No simplification candidates found — complexity is within thresholds.';
      const lines = [`Simplification candidates (${rows.length}):\n`];
      for (const r of rows) {
        const issues = [];
        if (r.complexity_cyclomatic !== null && r.complexity_cyclomatic >= thresholdCC) issues.push(`CC=${r.complexity_cyclomatic}`);
        if (r.maintainability_index !== null && r.maintainability_index <= thresholdMI) issues.push(`MI=${(r.maintainability_index as number).toFixed(1)}`);
        if (r.loc >= thresholdLOC) issues.push(`${r.loc}LOC`);
        lines.push(`  [${issues.join(', ')}] ${mapKind(r.kind)} \`${r.name}\` — ${r.file_path}:${r.start_line}`);
      }
      return lines.join('\n');
    }

    case 'kirograph_health': {
      // complexity_score (0–2500): % of function/method nodes with CC <= 10
      const ccRows = rawDb.all(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN complexity_cyclomatic <= 10 THEN 1 ELSE 0 END) as good
         FROM nodes WHERE kind IN ('function','method') AND complexity_cyclomatic IS NOT NULL`,
        []
      );
      let complexity_score: number;
      let complexityNote = '';
      if (!ccRows[0] || (ccRows[0] as any).total === 0) {
        complexity_score = 2500;
        complexityNote = ' (no CC data — set enableComplexity: true in config)';
      } else {
        const total = (ccRows[0] as any).total as number;
        const good = (ccRows[0] as any).good as number;
        complexity_score = Math.round((good / total) * 2500);
      }

      // dead_code_score (0–2500)
      const nodeCountRow = rawDb.all(
        `SELECT COUNT(*) as cnt FROM nodes WHERE kind NOT IN ('file','module')`,
        []
      );
      const totalNonFile = (nodeCountRow[0] as any)?.cnt as number ?? 0;
      let dead_code_score = 2500;
      if (totalNonFile > 0) {
        const deadRows = rawDb.all(
          `SELECT COUNT(*) as cnt FROM nodes n
           WHERE n.kind NOT IN ('file','module')
             AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id)
             AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source = n.id)`,
          []
        );
        const deadCount = (deadRows[0] as any)?.cnt as number ?? 0;
        const dead_code_ratio = deadCount / totalNonFile;
        dead_code_score = Math.round((1 - dead_code_ratio) * 2500);
      }

      // coupling_score (0–2500)
      const fanInRows = rawDb.all(
        `SELECT AVG(cnt) as avg_fan_in FROM (SELECT target, COUNT(*) as cnt FROM edges WHERE type='calls' GROUP BY target)`,
        []
      );
      const avg_fan_in = (fanInRows[0] as any)?.avg_fan_in as number ?? 0;
      let coupling_score: number;
      if (avg_fan_in < 3) coupling_score = 2500;
      else if (avg_fan_in < 6) coupling_score = 2000;
      else if (avg_fan_in < 10) coupling_score = 1500;
      else coupling_score = 1000;

      // circular_score (0–2500)
      const circRows = rawDb.all(
        `SELECT COUNT(DISTINCT source) as cnt FROM edges WHERE type='circular_dep'`,
        []
      );
      const circCount = (circRows[0] as any)?.cnt as number ?? 0;
      let circular_score: number;
      if (circCount === 0) circular_score = 2500;
      else if (circCount <= 5) circular_score = 2000;
      else if (circCount <= 15) circular_score = 1500;
      else if (circCount <= 30) circular_score = 1000;
      else circular_score = 500;

      const total_score = complexity_score + dead_code_score + coupling_score + circular_score;

      const gradeLabel = total_score >= 9000 ? 'Excellent'
        : total_score >= 7000 ? 'Good'
        : total_score >= 5000 ? 'Fair'
        : total_score >= 3000 ? 'Poor'
        : 'Critical';

      const lines = [
        `## Graph Health Score: ${total_score} / 10000  (${gradeLabel})\n`,
        `Breakdown:`,
        `  Complexity      ${complexity_score.toString().padStart(5)} / 2500${complexityNote}`,
        `  Dead Code       ${dead_code_score.toString().padStart(5)} / 2500  (avg dead ratio)`,
        `  Coupling        ${coupling_score.toString().padStart(5)} / 2500  (avg fan-in: ${avg_fan_in.toFixed(2)})`,
        `  Circular Deps   ${circular_score.toString().padStart(5)} / 2500  (${circCount} circular dep sources)`,
        '',
        `Interpretation:`,
        `  Complexity:    ${complexity_score >= 2000 ? 'Most functions have acceptable complexity.' : complexity_score >= 1500 ? 'Some high-complexity functions detected.' : 'Many high-complexity functions — refactor recommended.'}`,
        `  Dead Code:     ${dead_code_score >= 2000 ? 'Very little unreachable code.' : dead_code_score >= 1500 ? 'Some potentially dead code nodes.' : 'Significant dead code detected — consider cleanup.'}`,
        `  Coupling:      ${coupling_score >= 2000 ? 'Low coupling — healthy fan-in.' : coupling_score >= 1500 ? 'Moderate coupling.' : 'High coupling — consider reducing dependencies.'}`,
        `  Circular Deps: ${circular_score >= 2000 ? 'Few or no circular dependencies.' : circular_score >= 1500 ? 'Moderate circular dependencies.' : 'Many circular dependencies — architectural refactor recommended.'}`,
      ];
      if (complexityNote) lines.push('\nNote: enableComplexity: false in config — set to true and re-index for accurate complexity scoring.');
      return lines.join('\n');
    }

    case 'kirograph_dsm': {
      const limitN = clampLimit(args.limit as number | undefined, 15);

      // Get all nodes with file_path
      const nodes = rawDb.all(
        `SELECT id, file_path FROM nodes WHERE file_path IS NOT NULL AND file_path != ''`,
        []
      ) as Array<{ id: string; file_path: string }>;

      // Extract top-level dir
      const nodeGroup = new Map<string, string>();
      const groupSet = new Set<string>();
      for (const n of nodes) {
        const parts = n.file_path.replace(/\\/g, '/').split('/');
        const group = parts.length > 1 ? parts[0] : '<root>';
        nodeGroup.set(n.id, group);
        groupSet.add(group);
      }

      let groups = Array.from(groupSet).sort();
      if (groups.length > limitN) groups = groups.slice(0, limitN);

      if (groups.length === 0) return 'No nodes with file paths found in the index.';

      // Build matrix: for each pair (A, B), count edges from nodes in A to nodes in B
      const matrix: number[][] = groups.map(() => groups.map(() => 0));
      const edges = rawDb.all(
        `SELECT source, target FROM edges`,
        []
      ) as Array<{ source: string; target: string }>;

      for (const e of edges) {
        const srcGroup = nodeGroup.get(e.source);
        const tgtGroup = nodeGroup.get(e.target);
        if (!srcGroup || !tgtGroup) continue;
        const ri = groups.indexOf(srcGroup);
        const ci = groups.indexOf(tgtGroup);
        if (ri >= 0 && ci >= 0) matrix[ri][ci]++;
      }

      // Build text table
      const colWidth = Math.max(...groups.map(g => g.length), 6);
      const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);
      const lines = [`## Design Structure Matrix (${groups.length} groups)\n`];
      const header = ''.padEnd(colWidth + 2) + groups.map(g => pad(g, colWidth)).join('  ');
      lines.push(header);
      lines.push('-'.repeat(header.length));
      for (let r = 0; r < groups.length; r++) {
        const row = pad(groups[r], colWidth) + '  ' + matrix[r].map(v => v.toString().padEnd(colWidth)).join('  ');
        lines.push(row);
      }

      // Top 5 heaviest couplings
      const couplings: Array<{ a: string; b: string; count: number }> = [];
      for (let r = 0; r < groups.length; r++) {
        for (let c = 0; c < groups.length; c++) {
          if (r !== c && matrix[r][c] > 0) couplings.push({ a: groups[r], b: groups[c], count: matrix[r][c] });
        }
      }
      couplings.sort((x, y) => y.count - x.count);
      lines.push('\n## Top 5 Heaviest Couplings:');
      if (couplings.length === 0) {
        lines.push('  No cross-group dependencies found.');
      } else {
        for (const cp of couplings.slice(0, 5)) {
          lines.push(`  ${cp.a}  →  ${cp.b}  (${cp.count} edges)`);
        }
      }
      return lines.join('\n');
    }

    case 'kirograph_test_risk': {
      const limitN = clampLimit(args.limit as number | undefined, 20);
      const threshold = (args.threshold as number) ?? 0;

      // Risk = CC * fan_in (coverage and churn not yet available)
      const rows = rawDb.all(
        `SELECT n.name, n.kind, n.file_path, n.start_line,
                n.complexity_cyclomatic as cc,
                COUNT(e.source) as fan_in
         FROM nodes n
         LEFT JOIN edges e ON e.target = n.id AND e.type = 'calls'
         WHERE n.kind IN ('function','method')
           AND n.complexity_cyclomatic IS NOT NULL
         GROUP BY n.id
         HAVING (n.complexity_cyclomatic * COUNT(e.source)) > ?
         ORDER BY (n.complexity_cyclomatic * COUNT(e.source)) DESC
         LIMIT ?`,
        [threshold, limitN]
      ) as Array<{ name: string; kind: string; file_path: string; start_line: number; cc: number; fan_in: number }>;

      if (rows.length === 0) {
        return 'No test risk data found. Ensure complexity is enabled (enableComplexity: true) and re-index.';
      }

      const lines = [
        `## Test Risk Scores (top ${rows.length}, threshold=${threshold})\n`,
        `${'risk'.padEnd(8)}  ${'cc'.padEnd(6)}  ${'fan_in'.padEnd(8)}  kind        name  —  location`,
        '-'.repeat(80),
      ];
      for (const r of rows) {
        const risk = r.cc * r.fan_in;
        lines.push(
          `${risk.toString().padEnd(8)}  ${(r.cc ?? 0).toString().padEnd(6)}  ${r.fan_in.toString().padEnd(8)}  ${mapKind(r.kind).padEnd(10)}  \`${r.name}\` — ${r.file_path}:${r.start_line}`
        );
      }
      lines.push('\nNote: Coverage and churn factors not yet available — scores reflect complexity × fan-in only.');
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
