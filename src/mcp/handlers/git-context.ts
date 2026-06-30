import KiroGraph from '../../index';
import { mapKind } from './utils';
import type { ChangedSymbol } from '../../graph/git-context';

function formatChangedSymbol(s: ChangedSymbol): string {
  const lines = [`  ${mapKind(s.kind as any)} \`${s.name}\` (${s.changeType}) — ${s.filePath}:${s.startLine}`];
  if (s.callers.length > 0) lines.push(`    callers: ${s.callers.map(c => `\`${c.name}\``).join(', ')}`);
  if (s.callees.length > 0) lines.push(`    calls:   ${s.callees.map(c => `\`${c.name}\``).join(', ')}`);
  return lines.join('\n');
}

export async function handleGitContext(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  const { getChangedSymbols, getCommitContext, getPRContext, getCommitLog, findTestFiles, findUncoveredSymbols } = await import('../../graph/git-context');
  const projectRoot = cg.getProjectRoot();
  const db = cg.getDatabase();

  switch (toolName) {
    case 'kirograph_diff_context': {
      const staged = (args.staged as boolean) ?? false;
      let result;
      try {
        result = getChangedSymbols(projectRoot, db, { staged });
      } catch (err: any) {
        return `git diff failed: ${err.message}. Ensure this is a git repository with git installed.`;
      }
      if (result.changedSymbols.length === 0) {
        return staged ? 'No staged changes found.' : 'No unstaged changes found.';
      }
      const lines = [
        `${staged ? 'Staged' : 'Unstaged'} changes — ${result.changedSymbols.length} affected symbol(s):\n`,
      ];
      for (const s of result.changedSymbols) lines.push(formatChangedSymbol(s));
      return lines.join('\n');
    }

    case 'kirograph_commit_context': {
      let ctx;
      try {
        ctx = getCommitContext(projectRoot, db);
      } catch (err: any) {
        return `git diff failed: ${err.message}. Ensure this is a git repository with staged changes.`;
      }
      if (ctx.stagedFiles.length === 0) return 'No staged changes. Stage files with `git add` first.';
      const lines = [
        `Staged files (${ctx.stagedFiles.length}):\n`,
        ...ctx.stagedFiles.map(f => `  ${f}`),
        '\nDiff summary:',
        ctx.diffStat,
      ];
      if (ctx.changedSymbols.length > 0) {
        lines.push(`\nAffected symbols (${ctx.changedSymbols.length}):\n`);
        for (const s of ctx.changedSymbols) lines.push(formatChangedSymbol(s));
      }
      return lines.join('\n');
    }

    case 'kirograph_pr_context': {
      const base = args.base as string;
      const head = (args.head as string) ?? 'HEAD';
      let result;
      try {
        result = getPRContext(projectRoot, db, base, head);
      } catch (err: any) {
        return `PR context failed: ${err.message}`;
      }
      if (result.changedSymbols.length === 0) return `No symbol changes found between ${base} and ${head}.`;
      const lines = [
        `Semantic diff: ${result.ref} — ${result.changedSymbols.length} affected symbol(s):\n`,
      ];
      for (const s of result.changedSymbols) lines.push(formatChangedSymbol(s));
      return lines.join('\n');
    }

    case 'kirograph_changelog': {
      const ref1 = args.ref1 as string;
      const ref2 = (args.ref2 as string) ?? 'HEAD';
      let commits;
      try {
        commits = getCommitLog(projectRoot, ref1, ref2);
      } catch (err: any) {
        return `git log failed: ${err.message}`;
      }
      if (commits.length === 0) return `No commits found between ${ref1} and ${ref2}.`;
      let result;
      try {
        result = getPRContext(projectRoot, db, ref1, ref2);
      } catch { result = null; }
      const lines = [
        `## Changelog: ${ref1}..${ref2} (${commits.length} commits)\n`,
        ...commits.map(c => `- ${c.shortHash} ${c.date}  ${c.subject}  (${c.author})`),
      ];
      if (result && result.changedSymbols.length > 0) {
        lines.push(`\n## Affected symbols (${result.changedSymbols.length}):\n`);
        for (const s of result.changedSymbols.slice(0, 30)) lines.push(formatChangedSymbol(s));
        if (result.changedSymbols.length > 30) lines.push(`  …and ${result.changedSymbols.length - 30} more`);
      }
      return lines.join('\n');
    }

    case 'kirograph_test_map': {
      const symbol = args.symbol as string | undefined;
      if (symbol) {
        const results = cg.searchNodes(symbol, undefined, 5);
        if (results.length === 0) return `Symbol "${symbol}" not found in index.`;
        const node = results[0].node;
        const testFiles = findTestFiles(db, node.id);
        if (testFiles.length === 0) return `No test files found that reference \`${node.name}\`.`;
        return `Test files covering \`${node.name}\` (${testFiles.length}):\n\n` +
          testFiles.map(f => `  ${f}`).join('\n');
      } else {
        const uncovered = findUncoveredSymbols(db, 40);
        if (uncovered.length === 0) return 'All exported symbols appear to have test coverage.';
        const lines = [`Exported symbols with no test coverage (${uncovered.length}):\n`];
        let lastFile = '';
        for (const s of uncovered) {
          if (s.filePath !== lastFile) { lines.push(`\n${s.filePath}`); lastFile = s.filePath; }
          lines.push(`  ${mapKind(s.kind as any)} \`${s.name}\` — line ${s.startLine}`);
        }
        return lines.join('\n');
      }
    }

    case 'kirograph_flows': {
      const { getExecutionFlows, traceFlow } = await import('../../graph/flows');
      const db = cg.getDatabase();
      if (args.entryPoint) {
        const results = cg.searchNodes(args.entryPoint as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.entryPoint}" not found in index.`;
        const hops = traceFlow(db, results[0].node.id, (args.maxDepth as number) ?? 10);
        if (hops.length < 2) return `No outgoing call chain found from "${args.entryPoint}".`;
        const lines = [`## Execution flow from \`${args.entryPoint}\``, ''];
        for (let i = 0; i < hops.length; i++) {
          const hop = hops[i];
          const indent = '  '.repeat(i);
          const arrow = i === 0 ? '→' : '↳';
          const conf = hop.confidence && hop.confidence !== 'extracted' ? ` [${hop.confidence}]` : '';
          lines.push(`${indent}${arrow} ${hop.kind} \`${hop.symbol}\` — ${hop.filePath}:${hop.line}${conf}`);
        }
        return lines.join('\n');
      }
      const flows = getExecutionFlows(db, { maxFlows: (args.maxFlows as number) ?? 10, maxDepth: (args.maxDepth as number) ?? 10 });
      if (flows.length === 0) return 'No execution flows detected. The graph may be too small or have no call edges.';
      const lines = [`## Execution Flows (${flows.length} detected)`, ''];
      for (const flow of flows) {
        lines.push(`### \`${flow.entryPoint}\` (${flow.entryPointKind}) — criticality: ${flow.criticality.toFixed(2)}`);
        lines.push(`File: ${flow.entryPointFile}`, '');
        for (let i = 0; i < flow.hops.length; i++) {
          const hop = flow.hops[i];
          const indent = '  '.repeat(Math.min(i, 5));
          const arrow = i === 0 ? '→' : '↳';
          const conf = hop.confidence && hop.confidence !== 'extracted' ? ` [${hop.confidence}]` : '';
          lines.push(`${indent}${arrow} \`${hop.symbol}\` (${hop.kind}) — ${hop.filePath}:${hop.line}${conf}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    case 'kirograph_test_coverage': {
      const fs = await import('fs');
      const path = await import('path');
      const sortBy = (args.sortBy as string) ?? 'asc';
      const limitN = typeof args.limit === 'number' ? Math.max(1, Math.min(args.limit, 200)) : 30;

      // Search for coverage files
      const candidates = [
        'lcov.info',
        'coverage/lcov.info',
        '.nyc_output/lcov.info',
        'coverage/coverage-final.json',
      ];

      let foundPath: string | null = null;
      let fileType: 'lcov' | 'istanbul' | null = null;
      for (const rel of candidates) {
        const full = path.join(projectRoot, rel);
        if (fs.existsSync(full)) {
          foundPath = full;
          fileType = rel.endsWith('.json') ? 'istanbul' : 'lcov';
          break;
        }
      }

      if (!foundPath || !fileType) {
        return 'No coverage file found. Generate one with: nyc report --reporter=lcov, jest --coverage, or vitest run --coverage.';
      }

      const content = fs.readFileSync(foundPath, 'utf8');
      const fileCoverage: Array<{ file: string; covered: number; total: number; pct: number }> = [];

      if (fileType === 'lcov') {
        let currentFile = '';
        let covered = 0;
        let total = 0;
        for (const line of content.split('\n')) {
          if (line.startsWith('SF:')) {
            currentFile = line.slice(3).trim();
            covered = 0;
            total = 0;
          } else if (line.startsWith('DA:')) {
            const parts = line.slice(3).split(',');
            if (parts.length >= 2) {
              total++;
              if (parseInt(parts[1], 10) > 0) covered++;
            }
          } else if (line.startsWith('end_of_record') && currentFile) {
            const pct = total > 0 ? (covered / total) * 100 : 0;
            fileCoverage.push({ file: currentFile, covered, total, pct });
            currentFile = '';
          }
        }
      } else {
        // Istanbul JSON
        let json: Record<string, any>;
        try {
          json = JSON.parse(content);
        } catch {
          return 'Failed to parse coverage-final.json — invalid JSON.';
        }
        for (const [filePath, data] of Object.entries(json)) {
          const statements = data?.s as Record<string, number> | undefined;
          if (!statements) continue;
          const vals = Object.values(statements);
          const total = vals.length;
          const covered = vals.filter(v => v > 0).length;
          const pct = total > 0 ? (covered / total) * 100 : 0;
          fileCoverage.push({ file: filePath, covered, total, pct });
        }
      }

      if (fileCoverage.length === 0) return 'Coverage file found but no data could be parsed.';

      // Sort
      fileCoverage.sort((a, b) => sortBy === 'desc' ? b.pct - a.pct : a.pct - b.pct);

      // Overall coverage
      const totalLines = fileCoverage.reduce((s, f) => s + f.total, 0);
      const totalCovered = fileCoverage.reduce((s, f) => s + f.covered, 0);
      const overallPct = totalLines > 0 ? (totalCovered / totalLines) * 100 : 0;

      const lines = [
        `## Test Coverage Report (from ${path.relative(projectRoot, foundPath)})`,
        `Overall: ${overallPct.toFixed(1)}%  (${totalCovered}/${totalLines} lines)`,
        `Sorted by coverage ${sortBy === 'desc' ? 'DESC (highest first)' : 'ASC (lowest first)'}, showing top ${limitN}\n`,
      ];

      for (const f of fileCoverage.slice(0, limitN)) {
        const relFile = f.file.startsWith(projectRoot) ? f.file.slice(projectRoot.length + 1) : f.file;
        lines.push(`  ${f.pct.toFixed(1).padStart(5)}%  ${relFile} (${f.covered}/${f.total} lines)`);
      }

      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
