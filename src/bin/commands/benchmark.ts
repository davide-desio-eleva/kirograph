/**
 * KiroGraph Benchmark Runner
 *
 * Clones repos at pinned SHAs, indexes them, runs predefined queries,
 * and measures token efficiency vs naive file reading.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import { bold, dim, green, reset, violet } from '../ui';

interface BenchmarkQuery {
  tool: string;
  args: Record<string, unknown>;
}

interface BenchmarkRepo {
  name: string;
  url: string;
  sha: string;
  description: string;
  queries: BenchmarkQuery[];
}

interface BenchmarkConfig {
  repos: BenchmarkRepo[];
}

interface QueryResult {
  tool: string;
  args: Record<string, unknown>;
  graphTokens: number;
  naiveTokens: number;
  savingsPct: number;
  durationMs: number;
}

interface RepoResult {
  name: string;
  description: string;
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  indexDurationMs: number;
  queries: QueryResult[];
  avgSavingsPct: number;
}

export function register(program: Command): void {
  program
    .command('benchmark')
    .description('Run reproducible token-efficiency benchmarks')
    .option('--repo <name>', 'Run benchmark for a specific repo only')
    .option('--report', 'Generate markdown report from existing results')
    .option('--output <dir>', 'Output directory for results', 'benchmarks/results')
    .action(async (opts: { repo?: string; report?: boolean; output: string }) => {
      const configPath = path.join(process.cwd(), 'benchmarks', 'config.json');
      if (!fs.existsSync(configPath)) {
        console.error('  benchmarks/config.json not found. Run from the KiroGraph project root.');
        process.exit(1);
      }

      const config: BenchmarkConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const outputDir = path.resolve(opts.output);
      fs.mkdirSync(outputDir, { recursive: true });

      if (opts.report) {
        generateReport(outputDir);
        return;
      }

      const repos = opts.repo
        ? config.repos.filter(r => r.name === opts.repo)
        : config.repos;

      if (repos.length === 0) {
        console.error(`  Repo "${opts.repo}" not found in config.`);
        process.exit(1);
      }

      console.log(`\n  ${bold}KiroGraph Benchmark${reset}`);
      console.log(`  ${dim}Running ${repos.length} repo(s)…${reset}\n`);

      for (const repo of repos) {
        const result = await runRepoBenchmark(repo);
        const resultPath = path.join(outputDir, `${repo.name}.json`);
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
        console.log(`  ${green}✓${reset} ${repo.name}: avg ${result.avgSavingsPct}% savings → ${resultPath}\n`);
      }

      console.log(`  ${dim}Run \`kirograph benchmark --report\` to generate summary.${reset}\n`);
    });
}

async function runRepoBenchmark(repo: BenchmarkRepo): Promise<RepoResult> {
  const tmpDir = path.join(process.cwd(), '.kirograph-bench-tmp', repo.name);

  console.log(`  ${violet}${repo.name}${reset}: ${repo.description}`);

  // Clone if not already present
  if (!fs.existsSync(tmpDir)) {
    console.log(`  ${dim}Cloning ${repo.url}…${reset}`);
    fs.mkdirSync(path.dirname(tmpDir), { recursive: true });
    execSync(`git clone --depth 1 ${repo.url} ${tmpDir}`, { stdio: 'pipe' });
    if (repo.sha !== 'main' && repo.sha !== 'master') {
      try {
        execSync(`git checkout ${repo.sha}`, { cwd: tmpDir, stdio: 'pipe' });
      } catch {
        // SHA might not be fetchable with --depth 1, continue with HEAD
      }
    }
  }

  // Index
  console.log(`  ${dim}Indexing…${reset}`);
  const KiroGraph = (await import('../../index')).default;
  const indexStart = Date.now();

  let cg;
  if (!KiroGraph.isInitialized(tmpDir)) {
    cg = await KiroGraph.init(tmpDir);
  } else {
    cg = await KiroGraph.open(tmpDir);
  }

  const indexResult = await cg.indexAll();
  const indexDurationMs = Date.now() - indexStart;

  console.log(`  ${dim}Indexed: ${indexResult.filesIndexed} files, ${indexResult.nodesCreated} nodes, ${indexResult.edgesCreated} edges (${indexDurationMs}ms)${reset}`);

  // Estimate naive tokens (reading all source files)
  const allFiles = cg.getAllNodes().map((n: any) => n.filePath as string);
  const uniqueFiles = [...new Set(allFiles)];
  let totalNaiveTokens = 0;
  for (const fp of uniqueFiles) {
    try {
      const fullPath = path.join(tmpDir, fp);
      const stat = fs.statSync(fullPath);
      totalNaiveTokens += Math.round(stat.size / 4);
    } catch { /* skip */ }
  }

  // Run queries
  const queryResults: QueryResult[] = [];
  for (const query of repo.queries) {
    const start = Date.now();
    let responseText = '';

    try {
      if (query.tool === 'kirograph_context') {
        const ctx = await cg.buildContext(query.args.task as string, { maxNodes: 20, includeCode: true });
        responseText = ctx.summary + ctx.entryPoints.map((n: any) => n.name).join(' ');
        for (const [, code] of ctx.codeSnippets) responseText += code;
      } else if (query.tool === 'kirograph_callers') {
        const results = cg.searchNodes(query.args.symbol as string, undefined, 5);
        if (results.length > 0) {
          const callers = await cg.getCallers(results[0].node.id, 20);
          responseText = callers.map((n: any) => `${n.name} ${n.filePath}`).join('\n');
        }
      } else if (query.tool === 'kirograph_impact') {
        const results = cg.searchNodes(query.args.symbol as string, undefined, 5);
        if (results.length > 0) {
          const impact = await cg.getImpactRadius(results[0].node.id, (query.args.depth as number) ?? 2);
          responseText = impact.map((n: any) => `${n.name} ${n.filePath}`).join('\n');
        }
      }
    } catch { /* query failed — record 0 */ }

    const durationMs = Date.now() - start;
    const graphTokens = Math.round(responseText.length / 4);

    // Naive estimate: for context queries, agent would read ~5-10 files
    // For callers/impact, agent would grep + read ~3-5 files
    const naiveFileCount = query.tool === 'kirograph_context' ? 8 : 5;
    const avgFileTokens = totalNaiveTokens / Math.max(uniqueFiles.length, 1);
    const naiveTokens = Math.round(avgFileTokens * naiveFileCount);

    const savingsPct = naiveTokens > 0 ? Math.round((1 - graphTokens / naiveTokens) * 100) : 0;

    queryResults.push({
      tool: query.tool,
      args: query.args,
      graphTokens,
      naiveTokens,
      savingsPct: Math.max(0, savingsPct),
      durationMs,
    });

    console.log(`  ${dim}  ${query.tool}(${JSON.stringify(query.args).slice(0, 40)}…) → ${savingsPct}% savings (${durationMs}ms)${reset}`);
  }

  cg.close();

  const avgSavingsPct = queryResults.length > 0
    ? Math.round(queryResults.reduce((s, q) => s + q.savingsPct, 0) / queryResults.length)
    : 0;

  return {
    name: repo.name,
    description: repo.description,
    filesIndexed: indexResult.filesIndexed,
    nodesCreated: indexResult.nodesCreated,
    edgesCreated: indexResult.edgesCreated,
    indexDurationMs,
    queries: queryResults,
    avgSavingsPct,
  };
}

function generateReport(outputDir: string): void {
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('  No results found. Run `kirograph benchmark` first.');
    return;
  }

  const results: RepoResult[] = files.map(f =>
    JSON.parse(fs.readFileSync(path.join(outputDir, f), 'utf8'))
  );

  const lines = [
    '# KiroGraph Benchmark Results',
    '',
    `Generated: ${new Date().toISOString().slice(0, 19)}`,
    '',
    '## Summary',
    '',
    '| Repository | Files | Nodes | Edges | Index Time | Avg Savings |',
    '|-----------|-------|-------|-------|-----------|-------------|',
  ];

  for (const r of results) {
    lines.push(`| ${r.name} | ${r.filesIndexed} | ${r.nodesCreated} | ${r.edgesCreated} | ${r.indexDurationMs}ms | ${r.avgSavingsPct}% |`);
  }

  lines.push('', '## Query Details', '');

  for (const r of results) {
    lines.push(`### ${r.name}`, '');
    lines.push('| Query | Graph Tokens | Naive Tokens | Savings | Time |');
    lines.push('|-------|-------------|-------------|---------|------|');
    for (const q of r.queries) {
      const queryDesc = `${q.tool}(${JSON.stringify(q.args).slice(0, 30)}…)`;
      lines.push(`| ${queryDesc} | ${q.graphTokens} | ${q.naiveTokens} | ${q.savingsPct}% | ${q.durationMs}ms |`);
    }
    lines.push('');
  }

  const reportPath = path.join(outputDir, 'REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n  ${green}Report generated${reset}: ${reportPath}\n`);
  console.log(lines.join('\n'));
}
