/**
 * KiroGraph MCP Tool Definitions
 * Handler logic has been moved to src/mcp/handler.ts and src/mcp/handlers/*.ts
 */

export { KIROGRAPH_TOOL_NAMES } from './tool-names';
export { ToolHandler } from './handler';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown; items?: unknown; properties?: unknown }>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: 'kirograph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use kirograph_context for comprehensive task context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")' },
        mode: {
          type: 'string',
          description: 'Search mode: "name" (default, FTS prefix match) or "similar" (fuzzy substring match, broader results)',
          enum: ['name', 'similar'],
          default: 'name',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type_alias', 'variable', 'route', 'component'],
        },
        limit: { type: 'number', description: 'Max results 1-100 (default: 10)', default: 10 },
        projectPath: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_context',
    description: 'Build comprehensive context for a task or feature request.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description or feature name' },
        maxNodes: { type: 'number', description: 'Max symbols to include', default: 20 },
        includeCode: { type: 'boolean', description: 'Include code snippets. Deprecated — prefer detail.', default: true },
        detail: {
          type: 'string',
          description: 'Code verbosity: full, signatures, or summary',
          enum: ['full', 'signatures', 'summary'],
          default: 'full',
        },
        projectPath: { type: 'string' },
      },
      required: ['task'],
    },
  },
  {
    name: 'kirograph_callers',
    description: 'Find all functions/methods that call a specific symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find callers for' },
        limit: { type: 'number', description: 'Max results 1-100 (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_callees',
    description: 'Find all functions/methods that a specific symbol calls.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find callees for' },
        limit: { type: 'number', description: 'Max results 1-100 (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_impact',
    description: 'Analyze what code would be affected by changing a symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to analyze impact for' },
        depth: { type: 'number', description: 'Traversal depth (default: 2)', default: 2 },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_node',
    description: 'Get details about a specific symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name or fully-qualified name to look up' },
        qualified: { type: 'boolean', description: 'When true, treat symbol as a fully-qualified name (exact match, bypasses FTS — use when you have the exact qualifiedName from a previous result)', default: false },
        includeCode: { type: 'boolean', description: 'Include full source code. Deprecated — prefer detail.', default: false },
        detail: {
          type: 'string',
          description: 'Output level: summary, signatures, or full',
          enum: ['summary', 'signatures', 'full'],
          default: 'summary',
        },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_status',
    description: 'Check index health and statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_files',
    description: 'List indexed file structure with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        filterPath: { type: 'string', description: 'Filter by directory path prefix (e.g., "src/")' },
        pattern: { type: 'string', description: 'Filter by glob pattern (e.g., "**/*.ts")' },
        maxDepth: { type: 'number', description: 'Max directory depth to traverse' },
        format: {
          type: 'string',
          description: 'Output format: "tree" (default, visual tree), "flat" (one path per line), "grouped" (grouped by directory), "compact" (rtk-style summary with counts)',
          enum: ['tree', 'flat', 'grouped', 'compact'],
          default: 'tree',
        },
        includeMetadata: { type: 'boolean', description: 'Include language and symbol count', default: true },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_dead_code',
    description: 'Find symbols with no incoming references (potential dead code). Only includes unexported symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results 1-100 (default: 50)', default: 50 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_circular_deps',
    description: 'Find circular import dependencies in the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_path',
    description: 'Find the shortest path between two symbols in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol name' },
        to: { type: 'string', description: 'Target symbol name' },
        projectPath: { type: 'string' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'kirograph_architecture',
    description: 'Show high-level architecture: packages, layers, dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: 'packages, layers, or both',
          enum: ['packages', 'layers', 'both'],
          default: 'both',
        },
        includeFiles: { type: 'boolean', description: 'Include per-file package/layer assignments', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_coupling',
    description: 'Package coupling metrics: Ca, Ce, and instability (Ce/(Ca+Ce)).',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          description: 'Sort by instability, ca, ce, or name',
          enum: ['instability', 'afferent', 'efferent'],
          default: 'instability',
        },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_package',
    description: 'Drill into a package: files, exports, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'Package name or path (partial match accepted)' },
        includeFiles: { type: 'boolean', description: 'List files in the package (default: true)', default: true },
        projectPath: { type: 'string' },
      },
      required: ['package'],
    },
  },
  {
    name: 'kirograph_manifest',
    description: 'Workspace manifest summary: list all packages across ecosystems with versions, external dep counts, and license. Pass package= to drill into one package. Pass ecosystem= to filter (npm, cargo, go, python, maven, gradle, csproj). Pass showDrift=true to surface packages that appear in multiple manifest files with differing versions.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'Package name or path for a focused view (partial match accepted)' },
        ecosystem: { type: 'string', description: 'Filter by ecosystem / language (e.g. "npm", "cargo", "go", "python")' },
        showDrift: { type: 'boolean', description: 'Highlight packages declared in multiple manifests with different versions (default: false)', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_hotspots',
    description: 'Find the most-connected symbols in the codebase by total edge degree (incoming + outgoing). Useful for identifying load-bearing code, core abstractions, or blast-radius hot zones.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results 1-100 (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_surprising',
    description: 'Find non-obvious cross-file connections: direct edges between symbols in structurally distant parts of the codebase. High-score pairs indicate unexpected coupling worth investigating.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results 1-100 (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_diff',
    description: 'Compare current graph against a saved snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'string', description: 'Snapshot label; omit for latest' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_snapshot_save',
    description: 'Save a snapshot of the current graph state. Snapshots can be compared with kirograph_diff to track structural changes over time.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Label for the snapshot (default: timestamp-based label)' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_snapshot_list',
    description: 'List all saved graph snapshots with their labels, timestamps, and symbol/edge counts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_type_hierarchy',
    description: 'Traverse base and derived types of a class or interface.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Class or interface name' },
        direction: {
          type: 'string',
          description: 'up=base, down=derived, both=all',
          enum: ['up', 'down', 'both'],
          default: 'both',
        },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_module_api',
    description: 'List all exported symbols in a file or directory — the public API surface.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (e.g. "src/auth/service.ts") or directory prefix (e.g. "src/auth/"). Omit for the whole project.' },
        limit: { type: 'number', description: 'Max results (default: 100)', default: 100 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_rename_preview',
    description: 'Show every reference site for a symbol — blast-radius preview before a rename.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find all references for' },
        projectPath: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_doc_coverage',
    description: 'Find exported symbols that are missing docstrings.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_god_class',
    description: 'List classes ranked by member count to identify god classes.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Member count threshold for flagging (default: 10)', default: 10 },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_inheritance_depth',
    description: 'Show the deepest inheritance chains (BFS on extends/implements edges).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_recursion',
    description: 'Find recursive and mutually-recursive functions (SCC on call edges).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_largest',
    description: 'List symbols ranked by lines of code (end_line − start_line).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_rank',
    description: 'Rank symbols by fan-in (callers) or fan-out (callees) edge count.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'string', description: 'Ranking dimension: "fan-in" (default) or "fan-out"', enum: ['fan-in', 'fan-out'], default: 'fan-in' },
        limit: { type: 'number', description: 'Max results (default: 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_distribution',
    description: 'Symbol-kind breakdown (function, class, method…) for a file, directory, or the whole project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory or file path prefix to scope. Omit for whole project.' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_annotations',
    description: 'Decorator/annotation histogram for the whole project, or list of symbols using a specific decorator.',
    inputSchema: {
      type: 'object',
      properties: {
        decorator: { type: 'string', description: 'Decorator name to filter (e.g. "Injectable"). Omit for full histogram.' },
        limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_session_start',
    description: 'Save the current graph metrics as a session baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_session_end',
    description: 'Diff current graph metrics against the session baseline and report per-dimension deltas.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_unused_imports',
    description: 'Find import nodes with zero resolved downstream edges (i.e. nothing in the codebase references the imported symbol).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 50)' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_gini',
    description: 'Compute the Gini inequality coefficient for a size metric (loc, fan-in, or fan-out) across all function/method nodes. Returns the coefficient plus top/bottom 5.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description: 'Metric to measure: "loc" (lines of code), "fan-in" (incoming calls), "fan-out" (outgoing calls)',
          enum: ['loc', 'fan-in', 'fan-out'],
          default: 'loc',
        },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_dependency_depth',
    description: 'Run a Kahn topological sort on the file import graph and report each file\'s longest path from a root (depth). Useful for spotting deeply layered dependency chains.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max files to show sorted by depth DESC (default: 20)' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_exec',
    description: 'Run a shell command with token-optimized, noise-filtered output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
        level: {
          type: 'string',
          description: 'Compression level: "normal" (balanced), "aggressive" (more compact), "ultra" (maximum compression)',
          enum: ['normal', 'aggressive', 'ultra'],
          default: 'normal',
        },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 60 },
        projectPath: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'kirograph_gain',
    description: 'Show token savings from graph tools and shell compression.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time window: session, hour, day, week, all',
          enum: ['session', 'today', 'week', 'all'],
          default: 'session',
        },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_read',
    description: 'Read a file with caching; unchanged files return cache marker.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (absolute or relative to project root)' },
        mode: {
          type: 'string',
          description: 'Read mode: "full" (default), "map" (structure overview), "signatures" (function signatures), "diff" (changes since last read), "lines" (line range), "imports", "exports"',
          enum: ['full', 'map', 'signatures', 'diff', 'lines', 'imports', 'exports'],
          default: 'full',
        },
        start: { type: 'number', description: 'Start line (for lines mode)' },
        end: { type: 'number', description: 'End line (for lines mode)' },
        noCache: { type: 'boolean', description: 'Force fresh read, bypass cache', default: false },
        projectPath: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'kirograph_retrieve',
    description: 'Retrieve cached file content by path (CCR — Cached Content Retrieval). Returns the full content stored in the session cache, or reads and caches the file if not yet seen. Use after kirograph_read returns a "[cached: file unchanged]" marker to get the actual content without a redundant filesystem read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to retrieve (absolute or relative to project root)' },
        projectPath: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'kirograph_compress',
    description: 'Compress text via rtk shell filters or caveman grammar engine.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to compress' },
        command: { type: 'string', description: 'Shell command text came from (selects rtk engine)' },
        level: {
          type: 'string',
          description: 'Compression intensity: "lite" / "normal" (light), "full" / "aggressive" (default), "ultra" (maximum)',
          enum: ['lite', 'normal', 'full', 'aggressive', 'ultra'],
          default: 'full',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'kirograph_budget',
    description: 'Show session context budget: tokens used, remaining, utilization.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: { type: 'boolean', description: 'Reset session budget counters', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_flows',
    description: 'Trace execution flows from entry points through the call graph.',
    inputSchema: {
      type: 'object',
      properties: {
        entryPoint: { type: 'string', description: 'Symbol to trace; omit to auto-detect' },
        maxFlows: { type: 'number', description: 'Max number of flows to return (default 10)' },
        maxDepth: { type: 'number', description: 'Max call chain depth (default 10)' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_communities',
    description: 'Detect clusters of related symbols via graph community detection.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: { type: 'number', description: 'Granularity 0.1–2.0; higher=more smaller clusters' },
        limit: { type: 'number', description: 'Max communities to return (default 15)' },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Complexity tools (require enableComplexity=true) ──────────────────────────
  {
    name: 'kirograph_complexity',
    description: 'Rank symbols by cyclomatic complexity, cognitive complexity, or maintainability index. Requires enableComplexity: true and a re-index.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Ranking metric: "cyclomatic" (default), "cognitive", or "maintainability"', enum: ['cyclomatic', 'cognitive', 'maintainability'], default: 'cyclomatic' },
        threshold: { type: 'number', description: 'Flag symbols above (CC/cog) or below (MI) this threshold' },
        limit: { type: 'number', description: 'Max results (default: 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_simplify_scan',
    description: 'Find functions/methods that exceed complexity, size, or maintainability thresholds — simplification candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        thresholdCC: { type: 'number', description: 'Cyclomatic complexity threshold (default: 10)', default: 10 },
        thresholdMI: { type: 'number', description: 'Maintainability index lower bound — flag below this (default: 50)', default: 50 },
        thresholdLOC: { type: 'number', description: 'Lines of code threshold (default: 50)', default: 50 },
        limit: { type: 'number', description: 'Max results (default: 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Git context tools (require enableGitContext=true) ─────────────────────────
  {
    name: 'kirograph_diff_context',
    description: 'Identify symbols changed in the working tree (or staged), with their callers and callees for immediate blast-radius context.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'If true, show staged changes (git diff --cached) instead of unstaged', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_commit_context',
    description: 'Structured summary of staged changes — affected symbols, diff stat, staged files. Use to craft precise commit messages.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_pr_context',
    description: 'Semantic diff between two git refs — changed symbols with callers/callees. Use to write PR descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ref (branch name, tag, or commit hash)' },
        head: { type: 'string', description: 'Head ref (default: HEAD)', default: 'HEAD' },
        projectPath: { type: 'string' },
      },
      required: ['base'],
    },
  },
  {
    name: 'kirograph_changelog',
    description: 'Human-readable semantic changelog between two git refs: commit log + affected symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        ref1: { type: 'string', description: 'Start ref (older)' },
        ref2: { type: 'string', description: 'End ref (default: HEAD)', default: 'HEAD' },
        projectPath: { type: 'string' },
      },
      required: ['ref1'],
    },
  },
  {
    name: 'kirograph_test_map',
    description: 'Find test files covering a symbol, or list exported symbols with no test coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find tests for. Omit to list all uncovered exported symbols.' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_refactor',
    description: 'Rename preview (all references) or function summarization.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'rename=preview references, summarize=summary', enum: ['rename', 'suggest'] },
        symbol: { type: 'string', description: 'Symbol name (required for rename mode)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        projectPath: { type: 'string' },
      },
      required: ['mode'],
    },
  },
  // ── Edit primitives (require enableEditPrimitives=true) ───────────────────────
  {
    name: 'kirograph_str_replace',
    description: 'Replace a unique string anchor in a file; fails if the anchor appears 0 or >1 times.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to project root' },
        old_str: { type: 'string', description: 'Exact string to find (must be unique in the file)' },
        new_str: { type: 'string', description: 'Replacement string' },
        projectPath: { type: 'string' },
      },
      required: ['file', 'old_str', 'new_str'],
    },
  },
  {
    name: 'kirograph_multi_str_replace',
    description: 'Apply N replacements as an all-or-nothing transaction; aborts if any anchor is ambiguous or missing.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to project root' },
        pairs: {
          type: 'array',
          description: 'Array of {old_str, new_str} replacement pairs applied in order',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: 'Exact string to find (must be unique)' },
              new_str: { type: 'string', description: 'Replacement string' },
            },
          },
        },
        projectPath: { type: 'string' },
      },
      required: ['file', 'pairs'],
    },
  },
  {
    name: 'kirograph_insert_at',
    description: 'Insert content before or after a unique anchor string or line number.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to project root' },
        anchor: { type: 'string', description: 'Unique string anchor to insert relative to (mutually exclusive with line)' },
        line: { type: 'number', description: '1-based line number to insert relative to (mutually exclusive with anchor)' },
        content: { type: 'string', description: 'Content to insert (include newline if needed)' },
        position: { type: 'string', description: '"before" or "after" the anchor/line (default: "after")', enum: ['before', 'after'], default: 'after' },
        projectPath: { type: 'string' },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'kirograph_ast_grep_rewrite',
    description: 'Structural AST rewrite via ast-grep. Skipped if ast-grep is not installed.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path relative to project root' },
        pattern: { type: 'string', description: 'ast-grep pattern to match' },
        rewrite: { type: 'string', description: 'ast-grep rewrite template' },
        projectPath: { type: 'string' },
      },
      required: ['file', 'pattern', 'rewrite'],
    },
  },
  // ── Memory tools (require enableMemory=true) ────────────────────────────────
  {
    name: 'kirograph_mem_search',
    description: 'Search project memory for decisions, errors, patterns, context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        kind: {
          type: 'string',
          description: 'Filter by observation kind',
          enum: ['decision', 'error', 'pattern', 'architecture', 'summary', 'note'],
        },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
        sessionId: { type: 'string', description: 'Filter to specific session' },
        asOf: { type: 'number', description: 'Query facts valid at this timestamp (epoch ms). Filters out expired/superseded observations.' },
        projectPath: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_mem_store',
    description: 'Store an observation in project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Observation text' },
        kind: {
          type: 'string',
          description: 'Observation kind',
          enum: ['decision', 'error', 'pattern', 'architecture', 'summary', 'note'],
          default: 'note',
        },
        projectPath: { type: 'string' },
        topicKey: { type: 'string', description: "Stable semantic key for this observation (e.g. 'architecture/auth-model'). Enables addressing by concept." },
        reviewAfter: { type: 'number', description: 'ISO date to flag for review' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kirograph_mem_timeline',
    description: 'List recent sessions and their observations chronologically.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of sessions to show', default: 5 },
        sessionId: { type: 'string', description: 'Show observations for a specific session' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_status',
    description: 'Memory subsystem health: sessions, observations, embeddings, size.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Engram-parity mem tools ──────────────────────────────────────────────────
  {
    name: 'kirograph_mem_review',
    description: 'List observations past their review_after date.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_mark_reviewed',
    description: 'Clear review_after date on an observation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Observation ID' },
        projectPath: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kirograph_mem_compare',
    description: 'Establish a typed relation between two observations (supersedes, conflicts_with, compatible, scoped, related, not_conflict). Accepts observation IDs or topic_key values.',
    inputSchema: {
      type: 'object',
      properties: {
        observationA: { type: 'string', description: 'First observation ID or topic_key' },
        observationB: { type: 'string', description: 'Second observation ID or topic_key' },
        relation: { type: 'string', enum: ['supersedes', 'conflicts_with', 'compatible', 'scoped', 'related', 'not_conflict'], description: 'Relation type' },
        confidence: { type: 'number', description: 'Confidence 0.0–1.0 (default: 1.0)' },
        reason: { type: 'string', description: 'Explanation of the relation' },
        evidence: { type: 'string', description: 'Supporting evidence text' },
        projectPath: { type: 'string' },
      },
      required: ['observationA', 'observationB', 'relation'],
    },
  },
  {
    name: 'kirograph_mem_judge',
    description: 'Finalize a pending conflict relation — confirm, revise, or dismiss it.',
    inputSchema: {
      type: 'object',
      properties: {
        relationId: { type: 'string', description: 'Relation ID (from kirograph_mem_compare or kirograph_mem_search)' },
        relation: { type: 'string', enum: ['supersedes', 'conflicts_with', 'compatible', 'scoped', 'related', 'not_conflict'], description: 'Final relation type' },
        confidence: { type: 'number', description: 'Final confidence 0.0–1.0' },
        reason: { type: 'string', description: 'Reasoning' },
        evidence: { type: 'string', description: 'Supporting evidence' },
        projectPath: { type: 'string' },
      },
      required: ['relationId', 'relation', 'confidence'],
    },
  },
  {
    name: 'kirograph_mem_capture',
    description: 'Extract and store structured learnings from freeform text.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text block with structured sections' },
        projectPath: { type: 'string' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kirograph_mem_save_prompt',
    description: 'Save the current user prompt to session memory.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The user prompt text to save' },
        projectPath: { type: 'string' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kirograph_mem_suggest_topic_key',
    description: 'Suggest a stable topic_key slug for an observation.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['decision', 'error', 'pattern', 'architecture', 'summary', 'note'], description: 'Observation kind' },
        title: { type: 'string', description: 'Short description of the observation' },
        projectPath: { type: 'string' },
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'kirograph_mem_conflicts_scan',
    description: 'Scan recent observations for potential conflicts using FTS.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max observations to scan (default: 50)', default: 50 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_prune',
    description: 'Remove memory observations older than a given duration.',
    inputSchema: {
      type: 'object',
      properties: {
        olderThan: { type: 'string', description: 'Duration threshold e.g. "90d" or "6m"', default: '90d' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_lint',
    description: 'Health check: stale links, model mismatch, orphaned sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        fix: { type: 'boolean', description: 'Auto-remove stale links', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_conflicts_list',
    description: 'List pending conflict relations needing resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_mem_conflicts_ignore',
    description: 'Dismiss a pending conflict relation as not relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        relationId: { type: 'string', description: 'Relation ID to ignore (from kirograph_mem_conflicts_list)' },
        projectPath: { type: 'string' },
      },
      required: ['relationId'],
    },
  },
  // ── Wiki tools (require enableWiki=true) ────────────────────────────────────
  {
    name: 'kirograph_wiki_ingest',
    description: 'Build ingest prompt for LLM to produce a WIKI_DIFF.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source content to ingest (markdown, notes, ADR text, etc.)' },
        sourceName: { type: 'string', description: 'Name or path of the source', default: 'source' },
        projectPath: { type: 'string' },
      },
      required: ['source'],
    },
  },
  {
    name: 'kirograph_wiki_apply_diff',
    description: 'Apply a WIKI_DIFF to the wiki filesystem and SQLite index.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'WIKI_DIFF string with WIKI_DIFF_START/END blocks' },
        projectPath: { type: 'string' },
      },
      required: ['diff'],
    },
  },
  {
    name: 'kirograph_wiki_search',
    description: 'FTS over wiki pages; returns slugs, titles, previews.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)', default: 5 },
        projectPath: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_wiki_page',
    description: 'Retrieve full markdown of a wiki page by slug.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug (e.g. "arch/auth-model")' },
        projectPath: { type: 'string' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'kirograph_wiki_lint',
    description: 'Check wiki for broken links, orphans, stale sources, contradictions.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_wiki_list',
    description: 'List all wiki pages with slug, title, source count, date.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_wiki_synthesize',
    description: 'Run local-model wiki synthesis: process the pending source queue (requires wikiSynthesisMode: "local").',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_wiki_init',
    description: 'Initialize the wiki: create SCHEMA.md and MANIFEST.md in .kirograph/wiki/.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_wiki_reindex',
    description: 'Rebuild the SQLite index from .kirograph/wiki/*.md files on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_wiki_status',
    description: 'Show wiki subsystem stats: page count, total sources, oldest/newest page dates.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Docs tools (require enableDocs=true) ────────────────────────────────────
  {
    name: 'kirograph_docs_toc',
    description: 'Get TOC for a doc file or whole project (IDs, titles, levels, summaries).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filter to a specific doc file (relative path). Omit for project-wide TOC.' },
        tree: { type: 'boolean', description: 'Return nested tree structure.', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_docs_search',
    description: 'Search documentation sections by query, ranked by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        file: { type: 'string', description: 'Limit search to a specific doc file.' },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
        projectPath: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_docs_section',
    description: 'Retrieve full content of a doc section by its stable ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Section ID.' },
        context: { type: 'boolean', description: 'Include ancestor headings and child summaries.', default: false },
        projectPath: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kirograph_docs_outline',
    description: 'Get heading hierarchy for a single documentation file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Documentation file path (relative to project root).' },
        projectPath: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'kirograph_docs_refs',
    description: 'Bidirectional lookup: doc section↔code symbol references.',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: { type: 'string', description: 'Doc section ID to find referenced symbols.' },
        nodeId: { type: 'string', description: 'Code symbol ID to find referencing doc sections.' },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Data tools (require enableData=true) ────────────────────────────────────
  {
    name: 'kirograph_data_list',
    description: 'List all indexed datasets with row/column counts and file sizes.',
    inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } },
  },
  {
    name: 'kirograph_data_describe',
    description: 'Full schema profile: types, cardinality, null%, sample values.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID (from kirograph_data_list)' },
        column: { type: 'string', description: 'Deep-dive on a single column.' },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_query',
    description: 'Filtered row retrieval with structured operators (max 500 rows).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        filters: { type: 'array', description: 'Array of {column, op, value} filters. Ops: eq, neq, gt, gte, lt, lte, contains, in, is_null, between' },
        columns: { type: 'array', description: 'Column projection (only return these columns)' },
        limit: { type: 'number', description: 'Max rows (default: 100, hard cap: 500)', default: 100 },
        offset: { type: 'number', description: 'Pagination offset', default: 0 },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_aggregate',
    description: 'Server-side GROUP BY aggregation: count, sum, avg, min, max.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        groupBy: { type: 'array', description: 'Columns to group by' },
        metrics: { type: 'array', description: 'Array of {column, op} metrics. Ops: count, sum, avg, min, max, count_distinct' },
        filters: { type: 'array', description: 'Optional pre-filters (same format as kirograph_data_query)' },
        projectPath: { type: 'string' },
      },
      required: ['dataset', 'groupBy', 'metrics'],
    },
  },
  {
    name: 'kirograph_data_search',
    description: 'Search column names and sample values by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        query: { type: 'string', description: 'Search keyword' },
        projectPath: { type: 'string' },
      },
      required: ['dataset', 'query'],
    },
  },
  {
    name: 'kirograph_data_join',
    description: 'SQL JOIN across two indexed datasets.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'Left dataset ID' },
        right: { type: 'string', description: 'Right dataset ID' },
        leftColumn: { type: 'string', description: 'Join column from left dataset' },
        rightColumn: { type: 'string', description: 'Join column from right dataset' },
        type: { type: 'string', description: 'Join type: inner (default), left, right', enum: ['inner', 'left', 'right'], default: 'inner' },
        columns: { type: 'array', description: 'Column projection (prefix with dataset ID)' },
        limit: { type: 'number', description: 'Max rows (default: 100, hard cap: 500)', default: 100 },
        projectPath: { type: 'string' },
      },
      required: ['left', 'right', 'leftColumn', 'rightColumn'],
    },
  },
  {
    name: 'kirograph_data_correlations',
    description: 'Pairwise Pearson correlations between numeric columns.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        threshold: { type: 'number', description: 'Min absolute correlation to include (default: 0.3)', default: 0.3 },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_quality',
    description: 'Rank columns by data quality risk: nulls, cardinality, type issues.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_drift',
    description: 'Schema drift between last two index runs: columns, types, row counts.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID (from kirograph_data_list)' },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_history',
    description: 'History of schema snapshots: timestamps, row/column counts, hashes.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID (from kirograph_data_list)' },
        limit: { type: 'number', description: 'Max snapshots to return (default: 10)', default: 10 },
        projectPath: { type: 'string' },
      },
      required: ['dataset'],
    },
  },
  // ── Watchmen tools (require enableMemory=true + enableWatchmen=true) ──────────
  {
    name: 'kirograph_watchmen_status',
    description: 'Show watchmen status: pending observation count, synthesis threshold, and which brief files would be written on next synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_watchmen_synthesize',
    description: 'Run watchmen synthesis immediately using the local model (requires watchmenSynthesisMode: "local"). Processes pending observations into a workspace brief.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Run even if below threshold (default: false)', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_watchmen_reset',
    description: 'Reset the watchmen synthesis counter by storing a summary observation, without running full synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Affected tests ────────────────────────────────────────────────────────────
  {
    name: 'kirograph_affected',
    description: 'Find test files affected by a set of changed source files, by traversing the dependency graph.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of changed source file paths (relative to project root)',
        },
        depth: { type: 'number', description: 'Max dependency traversal depth (default: 5)', default: 5 },
        testPattern: { type: 'string', description: 'Custom glob to identify test files (optional)' },
        projectPath: { type: 'string' },
      },
      required: ['files'],
    },
  },
  // ── Security tools (require enableSecurity=true) ────────────────────────────
  {
    name: 'kirograph_security',
    description: 'Security overview: vuln counts, verdicts, stale data warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_vulns',
    description: 'List vulns with reachability verdicts, severity, affected components.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Filter by severity level', enum: ['critical', 'high', 'medium', 'low'] },
        verdict: { type: 'string', description: 'Filter by reachability verdict', enum: ['affected', 'not_affected', 'under_investigation'] },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        refresh: { type: 'boolean', description: 'Trigger fresh vulnerability enrichment before listing (default: false)', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_vuln_add',
    description: 'Manually register a CVE against a dependency.',
    inputSchema: {
      type: 'object',
      properties: {
        cveId: { type: 'string', description: 'CVE identifier (e.g., "CVE-2023-12345")' },
        package: { type: 'string', description: 'Package name to associate the CVE with' },
        severity: { type: 'number', description: 'CVSS v3.1 base score (optional)' },
        summary: { type: 'string', description: 'Vulnerability summary (optional)' },
        fixedVersion: { type: 'string', description: 'Version that fixes the vulnerability (optional)' },
        projectPath: { type: 'string' },
      },
      required: ['cveId', 'package'],
    },
  },
  {
    name: 'kirograph_vuln_suppress',
    description: 'Suppress a CVE from vulnerability reports.',
    inputSchema: {
      type: 'object',
      properties: {
        cveId: { type: 'string', description: 'CVE identifier to suppress (e.g., "CVE-2024-1234")' },
        reason: { type: 'string', description: 'Reason for suppression (optional)' },
        expires: { type: 'string', description: 'Expiry date in ISO format after which the suppression is removed (e.g. "2026-12-31", optional)' },
        projectPath: { type: 'string' },
      },
      required: ['cveId'],
    },
  },
  {
    name: 'kirograph_sbom',
    description: 'Generate CycloneDX 1.5 SBOM JSON for the project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_vex',
    description: 'Generate CycloneDX 1.5 VEX JSON with reachability verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_reachability',
    description: 'Check reachability for a dependency or CVE.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Dependency name or CVE ID to check reachability for' },
        projectPath: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'kirograph_staleness',
    description: 'Check dependency freshness against latest published versions.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Only return packages with staleness_score >= threshold (default: 0.3)', default: 0.3 },
        refresh: { type: 'boolean', description: 'Fetch latest version info from registries before listing (default: false)', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_licenses',
    description: 'Show licenses and check against configured deny/warn policy.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'boolean', description: 'Return only policy violations (default: false)', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_attack_surface',
    description: 'Map HTTP routes to vulnerable deps with hop count and auth status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max routes to return (default: 20)', default: 20 },
        publicOnly: { type: 'boolean', description: 'Only return public/unauthenticated routes', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_secrets',
    description: 'Scan for hardcoded secrets with call-graph blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        includeTests: { type: 'boolean', description: 'Include test files in scan', default: false },
        severity: { type: 'string', description: 'Filter by severity: critical, high, medium, low', enum: ['critical', 'high', 'medium', 'low'] },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_security_flows',
    description: 'SAST-lite: detect SQL injection, eval, deserialize, path, crypto flows.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type: sql, eval, deserialize, path, crypto, all', default: 'all' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_supply_chain',
    description: 'OpenSSF Scorecard scores, maintainer count, abandoned package detection.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'string', description: 'Minimum risk level: critical, high, medium', enum: ['critical', 'high', 'medium'] },
        refresh: { type: 'boolean', description: 'Re-fetch from APIs', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_dep_confusion',
    description: 'Detect dependency confusion: internal names in public registries.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_remediation',
    description: 'Remediation SLA tracking: overdue vulns by severity thresholds.',
    inputSchema: {
      type: 'object',
      properties: {
        overdueOnly: { type: 'boolean', description: 'Show only overdue items', default: false },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Phase 3 complexity tools ──────────────────────────────────────────────────
  {
    name: 'kirograph_health',
    description: 'Composite graph health score (0–10000) across complexity, dead code, coupling, and circular dependencies. Higher is better.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_dsm',
    description: 'Design Structure Matrix — dependency counts between top-level modules. Reveals architectural coupling and layering violations.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max module groups to include (default 15)', default: 15 },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_test_risk',
    description: 'Risk-ranked list of functions: complexity × fan-in. Highest-risk functions are most likely to break when changed.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
        threshold: { type: 'number', description: 'Min risk score to include (default 0)', default: 0 },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Phase 3 git context tools ─────────────────────────────────────────────────
  {
    name: 'kirograph_test_coverage',
    description: 'Parse lcov/Istanbul/Cobertura coverage files and show per-file coverage percentage. Sorted worst-first by default.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', description: 'Sort order: asc (worst first) or desc (best first)', enum: ['asc', 'desc'], default: 'asc' },
        limit: { type: 'number', description: 'Max results (default 30)', default: 30 },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Phase 4 branch tools ──────────────────────────────────────────────────────
  {
    name: 'kirograph_branch_list',
    description: 'List tracked branches with their DB sizes and last sync times.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_branch_diff',
    description: 'Symbols added, removed, or changed between two tracked branches.',
    inputSchema: {
      type: 'object',
      required: ['branchA'],
      properties: {
        branchA: { type: 'string', description: 'First branch name (required)' },
        branchB: { type: 'string', description: 'Second branch name (default: main)', default: 'main' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_branch_search',
    description: 'Search for symbols in a specific tracked branch graph.',
    inputSchema: {
      type: 'object',
      required: ['query', 'branch'],
      properties: {
        query: { type: 'string', description: 'Search query (symbol name, partial match)' },
        branch: { type: 'string', description: 'Branch name to search in' },
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
        projectPath: { type: 'string' },
      },
    },
  },
  // ── Pattern tools (require enablePatterns=true) ─────────────────────────────
  {
    name: 'kirograph_pattern_coverage',
    description: 'OWASP Top 10 coverage report: categories covered and match counts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_pattern_save_baseline',
    description: 'Save current pattern match counts as a baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Baseline label (default: "default")', default: 'default' },
        projectPath: { type: 'string' },
      },
    },
  },
  {
    name: 'kirograph_pattern_diff',
    description: 'Diff pattern matches against a saved baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Baseline label (default: "default")', default: 'default' },
        projectPath: { type: 'string' },
      },
    },
  },
];

/**
 * Dynamic tool definition for kirograph_live_search.
 * NOT included in the static `tools` array — injected into tools/list at runtime
 * only when config.enablePatterns === true AND @ast-grep/napi is available.
 * NOT added to KIROGRAPH_TOOL_NAMES (which is a static list for Kiro autoApprove).
 */
export const LIVE_SEARCH_TOOL_DEFINITION: ToolDefinition = {
  name: 'kirograph_live_search',
  description:
    'Run a live AST pattern search against the indexed file list using @ast-grep/napi. Finds structural code patterns (SQL injection, eval, path traversal, etc.) without needing the codebase to be re-indexed. Only available when enablePatterns: true.',
  inputSchema: {
    type: 'object' as const,
    required: ['pattern', 'language'],
    properties: {
      pattern: { type: 'string', description: 'ast-grep inline pattern (e.g. "eval($X)")' },
      language: { type: 'string', description: 'Language to search: javascript, typescript, python, go, rust, java, etc.' },
      limit: { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
      projectPath: { type: 'string' },
    },
  },
};
