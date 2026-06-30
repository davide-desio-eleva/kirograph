import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import KiroGraph from '../index';
import { logError } from '../errors';
import { compress } from '../compression/index';
import { TokenTracker } from '../compression/tracker';
import { truncate, writeSessionMarker } from './handlers/utils';
import { handleCore } from './handlers/core';
import { handleCodeHealth } from './handlers/code-health';
import { handleArchitecture } from './handlers/architecture';
import { handleEditPrimitives } from './handlers/edit-primitives';
import { handleGitContext } from './handlers/git-context';
import { handleComplexity } from './handlers/complexity';
import { handleMemory } from './handlers/memory';
import { handleDocs } from './handlers/docs';
import { handleData } from './handlers/data';
import { handleWatchmen } from './handlers/watchmen';
import { handleSecurity } from './handlers/security';
import { handlePatterns } from './handlers/patterns';
import { handleWiki } from './handlers/wiki';
import { handleBranch } from './handlers/branch';

const CORE_TOOLS = new Set([
  'kirograph_search', 'kirograph_context', 'kirograph_callers', 'kirograph_callees',
  'kirograph_impact', 'kirograph_node', 'kirograph_status', 'kirograph_files', 'kirograph_affected',
]);

const CODE_HEALTH_TOOLS = new Set([
  'kirograph_dead_code', 'kirograph_circular_deps', 'kirograph_path', 'kirograph_type_hierarchy',
  'kirograph_hotspots', 'kirograph_surprising', 'kirograph_diff', 'kirograph_snapshot_save',
  'kirograph_snapshot_list', 'kirograph_module_api', 'kirograph_rename_preview',
  'kirograph_doc_coverage', 'kirograph_god_class', 'kirograph_inheritance_depth',
  'kirograph_recursion', 'kirograph_largest', 'kirograph_rank', 'kirograph_distribution',
  'kirograph_annotations', 'kirograph_session_start', 'kirograph_session_end',
  'kirograph_unused_imports', 'kirograph_gini', 'kirograph_dependency_depth',
]);

const ARCHITECTURE_TOOLS = new Set([
  'kirograph_architecture', 'kirograph_coupling', 'kirograph_package', 'kirograph_communities',
  'kirograph_manifest',
]);

const GIT_CONTEXT_TOOLS = new Set([
  'kirograph_flows', 'kirograph_diff_context', 'kirograph_commit_context',
  'kirograph_pr_context', 'kirograph_changelog', 'kirograph_test_map',
  'kirograph_test_coverage',
]);

const COMPLEXITY_TOOLS = new Set([
  'kirograph_complexity', 'kirograph_simplify_scan',
  'kirograph_health', 'kirograph_dsm', 'kirograph_test_risk',
]);

const BRANCH_TOOLS = new Set(['kirograph_branch_list', 'kirograph_branch_diff', 'kirograph_branch_search']);

const EDIT_PRIMITIVES_TOOLS = new Set([
  'kirograph_refactor', 'kirograph_str_replace', 'kirograph_multi_str_replace',
  'kirograph_insert_at', 'kirograph_ast_grep_rewrite',
]);

const SECURITY_TOOLS = new Set([
  'kirograph_security', 'kirograph_vulns', 'kirograph_vuln_add', 'kirograph_vuln_suppress',
  'kirograph_sbom', 'kirograph_vex', 'kirograph_reachability', 'kirograph_staleness',
  'kirograph_licenses', 'kirograph_attack_surface', 'kirograph_secrets', 'kirograph_security_flows',
  'kirograph_supply_chain', 'kirograph_dep_confusion', 'kirograph_remediation',
]);

const PATTERNS_TOOLS = new Set([
  'kirograph_live_search', 'kirograph_pattern_coverage', 'kirograph_pattern_save_baseline',
  'kirograph_pattern_diff',
]);

const WATCHMEN_TOOLS = new Set([
  'kirograph_watchmen_status', 'kirograph_watchmen_synthesize', 'kirograph_watchmen_reset',
]);

export class ToolHandler {
  private defaultCg: KiroGraph | null;
  private connections = new Map<string, KiroGraph>();

  constructor(cg: KiroGraph | null) {
    this.defaultCg = cg;
  }

  setDefaultKiroGraph(cg: KiroGraph): void {
    this.defaultCg = cg;
  }

  /** Close all cached cross-project connections. */
  closeAll(): void {
    for (const cg of this.connections.values()) {
      try { cg.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }

  private async getConnection(projectPath?: string): Promise<KiroGraph | null> {
    if (!projectPath) return this.defaultCg;
    // Normalize and validate: must be an absolute path after resolution
    const resolved = path.resolve(projectPath);
    if (!path.isAbsolute(resolved)) return null;
    if (this.connections.has(resolved)) return this.connections.get(resolved)!;
    try {
      const cg = await KiroGraph.open(resolved);
      this.connections.set(resolved, cg);
      return cg;
    } catch {
      return null;
    }
  }

  async handle(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const text = await this.dispatch(toolName, args);
      const truncated = truncate(text);

      // Track graph/memory tool savings and append per-call metrics trailer.
      let metricsTrailer = '';
      if (toolName !== 'kirograph_exec' && toolName !== 'kirograph_gain') {
        try {
          const projectRoot = (args.projectPath as string) || this.defaultCg?.getProjectRoot() || process.cwd();
          const { estimateNaiveCost } = await import('../compression/naive-cost');
          const { estimateTokens } = await import('../compression/index');
          const outputTokens = estimateTokens(truncated);
          const naiveCost = estimateNaiveCost(toolName, outputTokens, args);
          if (naiveCost !== null && naiveCost > outputTokens) {
            const tracker = new TokenTracker(projectRoot);
            if (toolName.startsWith('kirograph_mem_')) {
              tracker.recordMemorySaving(toolName, outputTokens, naiveCost);
            } else if (toolName.startsWith('kirograph_docs_')) {
              tracker.recordDocsSaving(toolName, outputTokens, naiveCost);
            } else if (toolName.startsWith('kirograph_data_')) {
              tracker.recordDataSaving(toolName, outputTokens, naiveCost);
            } else {
              tracker.recordGraphSaving(toolName, outputTokens, naiveCost);
            }
            const saved = Math.round(((naiveCost - outputTokens) / naiveCost) * 100);
            metricsTrailer = `\n\n[kirograph_metrics: before=${naiveCost} after=${outputTokens} saved=${saved}%]`;
          } else {
            metricsTrailer = `\n\n[kirograph_metrics: tokens=${outputTokens}]`;
          }
        } catch { /* non-critical */ }
      }

      return { content: [{ type: 'text', text: truncated + metricsTrailer }] };
    } catch (err) {
      logError('MCP tool error', { tool: toolName, error: err });
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  private async dispatch(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Tools that don't require an initialized graph
    if (toolName === 'kirograph_exec') {
      const cmd = args.command as string;
      if (!cmd) return 'Error: command is required.';

      const projectRoot = (args.projectPath as string) || (args.cwd as string) || process.cwd();
      const execCwd = (args.cwd as string) || projectRoot;

      // Read default level from config if not explicitly provided
      let defaultLevel: 'normal' | 'aggressive' | 'ultra' = 'normal';
      try {
        const { loadConfig } = await import('../config');
        const config = await loadConfig(projectRoot);
        if (config.shellCompressionLevel && config.shellCompressionLevel !== 'off') {
          defaultLevel = config.shellCompressionLevel as 'normal' | 'aggressive' | 'ultra';
        }
      } catch { /* no config — use default */ }

      const level = (args.level as 'normal' | 'aggressive' | 'ultra') ?? defaultLevel;
      const timeout = ((args.timeout as number) ?? 60) * 1000;

      let rawOutput: string;
      let exitCode = 0;
      try {
        rawOutput = execSync(cmd, {
          cwd: execCwd,
          timeout,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err: any) {
        // Command failed — capture output anyway
        rawOutput = (err.stdout || '') + (err.stderr || '');
        exitCode = err.status ?? 1;
      }

      const result = compress(cmd, rawOutput, { level, preserveErrors: exitCode !== 0 });

      // Track savings
      const tracker = new TokenTracker(projectRoot);
      tracker.record(cmd, result.originalTokens, result.compressedTokens, result.strategy);

      const header = exitCode !== 0 ? `[exit ${exitCode}] ` : '';
      const footer = result.savings > 5
        ? `\n\n[${result.savings}% tokens saved | ${result.originalTokens}→${result.compressedTokens} | ${result.strategy}]`
        : '';

      return `${header}${result.output}${footer}`;
    }

    if (toolName === 'kirograph_gain') {
      const projectRoot = (args.projectPath as string) || process.cwd();
      const period = (args.period as string) ?? 'session';
      const tracker = new TokenTracker(projectRoot);
      const stats = tracker.getStats(period as 'session' | 'today' | 'week' | 'all');

      if (stats.totalCommands === 0) {
        return 'No savings recorded yet. Use kirograph tools and kirograph_exec — savings are tracked automatically.';
      }

      const lines = [
        `Token Savings (${period}):`,
        `  Total calls: ${stats.totalCommands}`,
        `  Tokens without KiroGraph: ~${stats.totalOriginal.toLocaleString()}`,
        `  Tokens with KiroGraph:    ~${stats.totalCompressed.toLocaleString()}`,
        `  Saved: ${stats.totalSaved.toLocaleString()} tokens (${stats.savingsPercent}%)`,
      ];

      // Source breakdown
      if (stats.bySource.exec.count > 0 || stats.bySource.graph.count > 0 || stats.bySource.memory.count > 0 || stats.bySource.docs.count > 0) {
        lines.push('', 'By source:');
        if (stats.bySource.graph.count > 0) {
          lines.push(`  Graph tools: ${stats.bySource.graph.count} calls, ~${stats.bySource.graph.saved.toLocaleString()} tokens saved (vs file reads/grep)`);
        }
        if (stats.bySource.docs.count > 0) {
          lines.push(`  Docs tools: ${stats.bySource.docs.count} calls, ~${stats.bySource.docs.saved.toLocaleString()} tokens saved (vs reading full doc files)`);
        }
        if (stats.bySource.data.count > 0) {
          lines.push(`  Data tools: ${stats.bySource.data.count} calls, ~${stats.bySource.data.saved.toLocaleString()} tokens saved (vs loading raw data files)`);
        }
        if (stats.bySource.exec.count > 0) {
          lines.push(`  Compression: ${stats.bySource.exec.count} calls, ~${stats.bySource.exec.saved.toLocaleString()} tokens saved (vs raw output)`);
        }
        if (stats.bySource.memory.count > 0) {
          lines.push(`  Memory: ${stats.bySource.memory.count} calls, ~${stats.bySource.memory.saved.toLocaleString()} tokens saved (vs re-discovering context)`);
        }
      }

      if (Object.keys(stats.byFamily).length > 0) {
        lines.push('', 'Top families:');
        for (const [family, data] of Object.entries(stats.byFamily).slice(0, 7)) {
          lines.push(`  ${family}: ${data.count} calls, ${data.savings}% avg savings`);
        }
      }

      if (stats.recentCommands.length > 0) {
        lines.push('', 'Recent:');
        for (const cmd of stats.recentCommands.slice(0, 5)) {
          const tag = cmd.source === 'graph' ? '📊' : '⚡';
          lines.push(`  ${tag} ${cmd.command.slice(0, 40)} → ${cmd.savings}% saved`);
        }
      }

      return lines.join('\n');
    }

    if (toolName === 'kirograph_read') {
      const filePath = args.path as string;
      if (!filePath) return 'Error: path is required.';

      const projectRoot = (args.projectPath as string) || process.cwd();
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
      const mode = (args.mode as string) ?? 'full';
      const noCache = (args.noCache as boolean) ?? false;

      if (!fs.existsSync(resolvedPath)) {
        return `Error: File not found: ${resolvedPath}`;
      }

      const { getFileReadCache } = await import('./cache');
      const { executeReadMode } = await import('./read-modes');
      const cache = getFileReadCache();

      // For non-full modes, skip caching logic and use read-modes directly
      if (mode !== 'full') {
        // Get graph connection for map/signatures/imports/exports modes
        let cg: KiroGraph | null = null;
        try {
          cg = await this.getConnection(args.projectPath as string | undefined);
        } catch { /* no graph available */ }

        const result = executeReadMode({
          mode: mode as any,
          filePath: resolvedPath,
          start: args.start as number | undefined,
          end: args.end as number | undefined,
          cg,
        });

        // Update cache with current content for future diff mode
        cache.read(resolvedPath, true);

        return result.content;
      }

      // Full mode with caching
      const result = cache.read(resolvedPath, noCache);

      if (result.cached) {
        return result.content;
      }

      if (result.changed) {
        return `[file changed since last read]\n\n${result.content}`;
      }

      return result.content;
    }

    if (toolName === 'kirograph_retrieve') {
      const filePath = args.path as string;
      if (!filePath) return 'Error: path is required.';

      const projectRoot = (args.projectPath as string) || process.cwd();
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);

      const { getFileReadCache } = await import('./cache');
      const cache = getFileReadCache();

      // Return cached content if we have it; otherwise read and cache
      const cached = cache.getPreviousContent(resolvedPath);
      if (cached !== undefined) {
        return cached;
      }

      if (!fs.existsSync(resolvedPath)) {
        return `Error: File not found: ${resolvedPath}`;
      }

      // Not in cache yet — do a fresh read and populate it
      const result = cache.read(resolvedPath, true);
      return result.content;
    }

    if (toolName === 'kirograph_compress') {
      const text = args.text as string;
      if (!text) return 'Error: text is required.';

      const rawLevel = (args.level as string) ?? 'full';
      const command = args.command as string | undefined;
      const { estimateTokens: est } = await import('../compression/index');
      const originalTokens = est(text);

      let compressed: string;
      let strategy: string;

      if (command) {
        // Shell output — use rtk-style structural filters
        const shellLevel = rawLevel === 'ultra' ? 'ultra' : rawLevel === 'lite' || rawLevel === 'normal' ? 'normal' : 'aggressive';
        const { compress } = await import('../compression/index');
        const result = compress(command, text, { level: shellLevel as any });
        compressed = result.output;
        strategy = `rtk:${result.commandFamily}:${shellLevel}`;
      } else {
        // Prose / observations — use caveman grammar
        const cavemanLevel = rawLevel === 'normal' || rawLevel === 'lite' ? 'lite' : rawLevel === 'aggressive' ? 'full' : rawLevel as any;
        const { compressObservation } = await import('../memory/compress');
        const result = compressObservation(text, cavemanLevel);
        compressed = result.compressed;
        strategy = `caveman:${cavemanLevel}`;
      }

      const compressedTokens = est(compressed);
      const savings = originalTokens > 0 ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100) : 0;
      const footer = savings > 5
        ? `\n\n[${savings}% tokens saved | ${originalTokens}→${compressedTokens} | ${strategy}]`
        : '';

      return compressed + footer;
    }

    if (toolName === 'kirograph_budget') {
      const projectRoot = (args.projectPath as string) || process.cwd();
      const reset = (args.reset as boolean) ?? false;

      const { BudgetTracker } = await import('../compression/tracker');
      const budget = BudgetTracker.getInstance(projectRoot);

      if (reset) {
        budget.reset();
        return 'Context budget counters reset.';
      }

      const status = budget.getStatus();
      const lines = [
        'Context Budget:',
        `  Tokens consumed: ${status.consumed.toLocaleString()}`,
        `  Budget limit:    ${status.limit > 0 ? status.limit.toLocaleString() : 'unlimited'}`,
        `  Remaining:       ${status.limit > 0 ? status.remaining.toLocaleString() : '∞'}`,
        `  Utilization:     ${status.utilization}%`,
      ];

      if (status.warning) {
        lines.push(`\n  ⚠ ${status.warning}`);
      }

      return lines.join('\n');
    }

    const cg = await this.getConnection(args.projectPath as string | undefined);
    if (!cg) return 'KiroGraph not initialized. Run `kirograph init` in your project first.';

    // Write session marker so hooks can detect MCP was consulted
    writeSessionMarker(cg.getProjectRoot());

    if (CORE_TOOLS.has(toolName)) return handleCore(toolName, args, cg);
    if (CODE_HEALTH_TOOLS.has(toolName)) return handleCodeHealth(toolName, args, cg);
    if (ARCHITECTURE_TOOLS.has(toolName)) return handleArchitecture(toolName, args, cg);
    if (GIT_CONTEXT_TOOLS.has(toolName)) return handleGitContext(toolName, args, cg);
    if (COMPLEXITY_TOOLS.has(toolName)) return handleComplexity(toolName, args, cg);
    if (BRANCH_TOOLS.has(toolName)) return handleBranch(toolName, args, cg);
    if (EDIT_PRIMITIVES_TOOLS.has(toolName)) return handleEditPrimitives(toolName, args, cg);
    if (SECURITY_TOOLS.has(toolName)) return handleSecurity(toolName, args, cg);
    if (PATTERNS_TOOLS.has(toolName)) return handlePatterns(toolName, args, cg);
    if (WATCHMEN_TOOLS.has(toolName)) return handleWatchmen(toolName, args, cg);
    if (toolName.startsWith('kirograph_mem_')) return handleMemory(toolName, args, cg);
    if (toolName.startsWith('kirograph_docs_')) return handleDocs(toolName, args, cg);
    if (toolName.startsWith('kirograph_data_')) return handleData(toolName, args, cg);
    if (toolName.startsWith('kirograph_wiki_')) return handleWiki(toolName, args, cg);

    return `Unknown tool: ${toolName}`;
  }
}
