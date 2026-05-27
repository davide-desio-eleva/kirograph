/**
 * KiroGraph MCP Tool Definitions + Handlers
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import KiroGraph, { findNearestKiroGraphRoot } from '../index';
import type { NodeKind } from '../types';
import { logError } from '../errors';
import { compress, estimateTokens, detectCommandFamily } from '../compression/index';
import { TokenTracker } from '../compression/tracker';
export { KIROGRAPH_TOOL_NAMES } from './tool-names';

const MAX_OUTPUT = 15_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[truncated]' : s;
}

/** Estimate how many tokens reading the full files would cost (chars / 4 heuristic). */
function estimateFileTokens(projectRoot: string, filePaths: string[]): number {
  let total = 0;
  for (const fp of filePaths) {
    try {
      const fullPath = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
      const stat = fs.statSync(fullPath);
      total += Math.round(stat.size / 4);
    } catch {
      // File may not exist or be unreadable — skip
    }
  }
  return total;
}

function clampLimit(value: number | undefined, defaultValue: number): number {
  const n = typeof value === 'number' ? value : defaultValue;
  return Math.max(1, Math.min(100, Math.round(n)));
}

/** Map internal kind values to human-readable MCP response kinds. */
function mapKind(kind: string): string {
  if (kind === 'type_alias') return 'type';
  return kind;
}

/** Write a session marker so hooks can detect MCP was consulted. */
function writeSessionMarker(projectRoot: string): void {
  try {
    const hash = crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
    fs.writeFileSync(`/tmp/kirograph-consulted-${hash}`, String(Date.now()));
  } catch { /* best-effort */ }
}

/** Format a timestamp as a human-readable relative age. */
function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; default?: unknown }>;
    required?: string[];
  };
}

export const tools: ToolDefinition[] = [
  {
    name: 'kirograph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use kirograph_context for comprehensive task context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")' },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type_alias', 'variable', 'route', 'component'],
        },
        limit: { type: 'number', description: 'Max results 1-100 (default: 10)', default: 10 },
        projectPath: { type: 'string', description: 'Project root path (optional, defaults to current project)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_context',
    description: 'PRIMARY TOOL: Build comprehensive context for a task or feature request. Returns entry points, related symbols, and key code — often enough to understand the codebase without additional tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task, bug, or feature to build context for' },
        maxNodes: { type: 'number', description: 'Max symbols to include (default: 20)', default: 20 },
        includeCode: { type: 'boolean', description: 'Include code snippets (default: true)', default: true },
        projectPath: { type: 'string', description: 'Project root path (optional, defaults to current project)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_impact',
    description: 'Analyze what code would be affected by changing a symbol. Use before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to analyze impact for' },
        depth: { type: 'number', description: 'Traversal depth (default: 2)', default: 2 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_node',
    description: 'Get details about a specific symbol, optionally including its source code.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to look up' },
        includeCode: { type: 'boolean', description: 'Include source code (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_files',
    description: 'List the indexed file structure of the project. Supports filtering by path prefix, glob pattern, or depth.',
    inputSchema: {
      type: 'object',
      properties: {
        filterPath: { type: 'string', description: 'Filter by directory path prefix (e.g., "src/")' },
        pattern: { type: 'string', description: 'Filter by glob pattern (e.g., "**/*.ts")' },
        maxDepth: { type: 'number', description: 'Limit tree depth' },
        format: {
          type: 'string',
          description: 'Output format: "tree" (default, visual tree), "flat" (one path per line), "grouped" (grouped by directory), "compact" (rtk-style summary with counts)',
          enum: ['tree', 'flat', 'grouped', 'compact'],
          default: 'tree',
        },
        includeMetadata: { type: 'boolean', description: 'Include language and symbol count (default: true)', default: true },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_circular_deps',
    description: 'Find circular import dependencies in the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'kirograph_architecture',
    description: 'Get the high-level software architecture: packages, layers, and their dependencies. Requires enableArchitecture=true in config. Call this first on a new task to orient yourself without reading files.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: 'View level: "packages" (package graph), "layers" (architectural layers), or "both" (default)',
          enum: ['packages', 'layers', 'both'],
          default: 'both',
        },
        includeFiles: { type: 'boolean', description: 'Include per-file package/layer assignments (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_coupling',
    description: 'Show coupling metrics for packages: afferent (Ca), efferent (Ce), and instability (Ce/(Ca+Ce)). High instability = depends on many others; low instability = depended on by many. Requires enableArchitecture=true.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          description: 'Sort order: "instability" (default), "afferent", or "efferent"',
          enum: ['instability', 'afferent', 'efferent'],
          default: 'instability',
        },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_package',
    description: 'Drill into one package: files it contains, symbols it exports, packages it depends on, and packages that depend on it. Requires enableArchitecture=true.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'Package name or path (partial match accepted)' },
        includeFiles: { type: 'boolean', description: 'List files in the package (default: true)', default: true },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['package'],
    },
  },
  {
    name: 'kirograph_hotspots',
    description: 'Find the most-connected symbols in the codebase by total edge degree (incoming + outgoing). Useful for identifying load-bearing code, core abstractions, or blast-radius hot zones.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results 1-100 (default: 20)', default: 20 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_diff',
    description: 'Compare the current graph against a saved snapshot. Shows added/removed symbols and relationships since the snapshot was taken. Use `kirograph snapshot` CLI command to save a snapshot first.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'string', description: 'Snapshot label to compare against. Omit to use the latest saved snapshot.' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_type_hierarchy',
    description: 'Traverse the type hierarchy of a class or interface (base types and derived types).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Class or interface name' },
        direction: {
          type: 'string',
          description: 'Direction: "up" for base types, "down" for derived types, "both" for all (default)',
          enum: ['up', 'down', 'both'],
          default: 'both',
        },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_exec',
    description: 'Run a shell command and return token-optimized output. Automatically filters noise from git, test runners, linters, build tools, docker, and package managers. Use instead of raw shell for 60-90% token savings on verbose commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g., "git status", "npm test", "cargo build")' },
        cwd: { type: 'string', description: 'Working directory (default: project root)' },
        level: {
          type: 'string',
          description: 'Compression level: "normal" (balanced), "aggressive" (more compact), "ultra" (maximum compression)',
          enum: ['normal', 'aggressive', 'ultra'],
          default: 'normal',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 60)', default: 60 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'kirograph_gain',
    description: 'Show token savings statistics — both from graph tools (vs manual file reads/grep) and from kirograph_exec shell compression.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Time period: "session" (current), "today", "week", or "all"',
          enum: ['session', 'today', 'week', 'all'],
          default: 'session',
        },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_read',
    description: 'Read a file with caching and multiple modes. First read returns full content; subsequent reads of unchanged files return a compact "cached" marker (~13 tokens). Supports modes: full, map, signatures, diff, lines, imports, exports.',
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
        noCache: { type: 'boolean', description: 'Force fresh read, bypass cache (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'kirograph_budget',
    description: 'Show current session context budget usage. Returns tokens consumed, remaining budget, and utilization percentage.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: { type: 'boolean', description: 'Reset session budget counters (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_flows',
    description: 'Trace execution flows from entry points (routes, handlers, main functions) through the call graph. Returns ordered call chains sorted by criticality.',
    inputSchema: {
      type: 'object',
      properties: {
        entryPoint: { type: 'string', description: 'Symbol name to trace from, or omit to auto-detect entry points' },
        maxFlows: { type: 'number', description: 'Max number of flows to return (default 10)' },
        maxDepth: { type: 'number', description: 'Max call chain depth (default 10)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_communities',
    description: 'Detect code communities (clusters of related symbols) using graph-based community detection. Shows which code belongs together and how communities are coupled.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: { type: 'number', description: 'Resolution parameter (default 1.0, higher = more communities)' },
        limit: { type: 'number', description: 'Max communities to return (default 15)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_refactor',
    description: 'Refactoring assistant. Use mode "rename" to preview all locations that reference a symbol (rename preview). Use mode "suggest" for community-driven refactoring suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'Mode: "rename" (preview references) or "suggest" (refactoring suggestions)', enum: ['rename', 'suggest'] },
        symbol: { type: 'string', description: 'Symbol name (required for rename mode)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['mode'],
    },
  },
  // ── Memory tools (require enableMemory=true) ────────────────────────────────
  {
    name: 'kirograph_mem_search',
    description: 'Search project memory for past decisions, errors, patterns, and context. Returns observations ranked by relevance.',
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_mem_store',
    description: 'Store an observation in project memory. Content is automatically compressed (if caveman mode is on) and linked to relevant code symbols.',
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        limit: { type: 'number', description: 'Number of sessions to show (default: 5)', default: 5 },
        sessionId: { type: 'string', description: 'Show observations for a specific session' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_mem_status',
    description: 'Memory subsystem health: session count, observations, embedding coverage, storage size.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  // ── Docs tools (require enableDocs=true) ────────────────────────────────────
  {
    name: 'kirograph_docs_toc',
    description: 'Get table of contents for a documentation file or the whole project. Returns section IDs, titles, levels, and summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filter to a specific doc file (relative path). Omit for project-wide TOC.' },
        tree: { type: 'boolean', description: 'Return nested tree structure (default: false, flat list)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_docs_search',
    description: 'Search documentation sections by query. Returns matching sections ranked by relevance. Independent from kirograph_search (code-only).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        file: { type: 'string', description: 'Narrow search to a specific doc file (relative path)' },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_docs_section',
    description: 'Retrieve full content of a documentation section by its stable ID. Use context=true to also get ancestor headings and child summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Section ID (from kirograph_docs_toc or kirograph_docs_search results)' },
        context: { type: 'boolean', description: 'Include ancestor heading chain and child summaries (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kirograph_docs_outline',
    description: 'Get the heading hierarchy for a single documentation file. Lighter than full TOC when you know which file is relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path to the doc file' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'kirograph_docs_refs',
    description: 'Find code symbols referenced by a doc section, or doc sections that reference a code symbol. Bidirectional lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: { type: 'string', description: 'Doc section ID (find code symbols it references)' },
        nodeId: { type: 'string', description: 'Code symbol qualified name (find doc sections that reference it)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  // ── Data tools (require enableData=true) ────────────────────────────────────
  {
    name: 'kirograph_data_list',
    description: 'List all indexed datasets with row counts, column counts, and file sizes.',
    inputSchema: { type: 'object', properties: { projectPath: { type: 'string', description: 'Project root path (optional)' } } },
  },
  {
    name: 'kirograph_data_describe',
    description: 'Full schema profile of a dataset: column names, types, cardinality, null%, sample values. Use to orient on a dataset without reading any rows.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID (from kirograph_data_list)' },
        column: { type: 'string', description: 'Optional: deep-dive on a single column' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_query',
    description: 'Filtered row retrieval with structured operators. Returns only matching rows (max 500). Use instead of reading raw data files.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        filters: { type: 'array', description: 'Array of {column, op, value} filters. Ops: eq, neq, gt, gte, lt, lte, contains, in, is_null, between' },
        columns: { type: 'array', description: 'Column projection (only return these columns)' },
        limit: { type: 'number', description: 'Max rows (default: 100, hard cap: 500)', default: 100 },
        offset: { type: 'number', description: 'Pagination offset', default: 0 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_aggregate',
    description: 'Server-side GROUP BY aggregation. Computation runs in SQLite — only the result set enters context. Use for count, sum, avg, min, max questions.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        groupBy: { type: 'array', description: 'Columns to group by' },
        metrics: { type: 'array', description: 'Array of {column, op} metrics. Ops: count, sum, avg, min, max, count_distinct' },
        filters: { type: 'array', description: 'Optional pre-filters (same format as kirograph_data_query)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset', 'groupBy', 'metrics'],
    },
  },
  {
    name: 'kirograph_data_search',
    description: 'Search column names and sample values by keyword. Tells you which column holds the answer without loading data.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        query: { type: 'string', description: 'Search keyword' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset', 'query'],
    },
  },
  {
    name: 'kirograph_data_join',
    description: 'SQL JOIN across two indexed datasets. Combines data without loading either file into context.',
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
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['left', 'right', 'leftColumn', 'rightColumn'],
    },
  },
  {
    name: 'kirograph_data_correlations',
    description: 'Pairwise Pearson correlations between numeric columns. Discovers hidden relationships without loading data.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        threshold: { type: 'number', description: 'Min absolute correlation to include (default: 0.3)', default: 0.3 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'kirograph_data_quality',
    description: 'Data quality triage: rank columns by risk (null rate, cardinality anomalies, type issues). Identifies problematic columns without loading data.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset ID' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['dataset'],
    },
  },
];

export class ToolHandler {
  private defaultCg: KiroGraph | null;
  private connections = new Map<string, KiroGraph>();
  /** Anti-loop: track recent data_query calls per dataset for pagination detection. */
  private queryTracker = new Map<string, { offsets: number[]; lastCall: number }>();

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

  /** Anti-loop: detect pagination patterns and warn the agent. */
  private checkPaginationLoop(dataset: string, offset: number | undefined, response: string): string {
    const now = Date.now();
    const key = dataset;
    const currentOffset = offset ?? 0;

    // Clean stale entries (older than 60s)
    for (const [k, v] of this.queryTracker) {
      if (now - v.lastCall > 60_000) this.queryTracker.delete(k);
    }

    const entry = this.queryTracker.get(key) ?? { offsets: [], lastCall: 0 };
    entry.offsets.push(currentOffset);
    entry.lastCall = now;

    // Keep only last 10 offsets
    if (entry.offsets.length > 10) entry.offsets = entry.offsets.slice(-10);
    this.queryTracker.set(key, entry);

    // Check for pagination pattern: >5 calls with incrementing offsets
    if (entry.offsets.length > 5) {
      const recent = entry.offsets.slice(-6);
      let isIncrementing = true;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i]! <= recent[i - 1]!) { isIncrementing = false; break; }
      }
      if (isIncrementing) {
        return response + '\n\n⚠ Pagination detected. Consider using kirograph_data_aggregate for summary statistics instead of paginating through all rows.';
      }
    }

    return response;
  }

  private async getConnection(projectPath?: string): Promise<KiroGraph | null> {
    if (!projectPath) return this.defaultCg;
    const resolved = path.resolve(projectPath);
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

      // Track graph/memory tool savings (skip exec/gain — they track themselves)
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
          }
        } catch { /* non-critical */ }
      }

      return { content: [{ type: 'text', text: truncated }] };
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

    switch (toolName) {
      case 'kirograph_search': {
        const limit = clampLimit(args.limit as number | undefined, 10);
        const results = cg.searchNodes(
          args.query as string,
          args.kind as NodeKind | undefined,
          limit
        );
        if (results.length === 0) return `No symbols found matching "${args.query}".`;
        return results.map(r =>
          `${mapKind(r.node.kind)} ${r.node.name}\n  File: ${r.node.filePath}:${r.node.startLine}\n  Qualified: ${r.node.qualifiedName}`
        ).join('\n\n');
      }

      case 'kirograph_context': {
        const ctx = await cg.buildContext(args.task as string, {
          maxNodes: (args.maxNodes as number) ?? 20,
          includeCode: (args.includeCode as boolean) ?? true,
        });
        const lines: string[] = [ctx.summary, ''];
        if (ctx.entryPoints.length === 0) {
          lines.push('No matching symbols found. If this is a new feature, consider using kirograph_files to explore the codebase structure.');
        } else {
          lines.push('## Entry Points');
          for (const n of ctx.entryPoints) {
            lines.push(`- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
            if (ctx.codeSnippets.has(n.id)) {
              lines.push('```', ctx.codeSnippets.get(n.id)!, '```');
            }
          }
          if (ctx.relatedNodes.length > 0) {
            lines.push('', '## Related Symbols');
            for (const n of ctx.relatedNodes.slice(0, 10)) {
              lines.push(`- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
            }
          }
        }

        // Memory integration: surface relevant observations if memory is enabled
        try {
          const { loadConfig } = await import('../config');
          const projectRoot = cg.getProjectRoot();
          const config = await loadConfig(projectRoot);
          if (config.enableMemory) {
            const { MemoryManager } = await import('../memory/index');
            const db = cg.getDatabase();
            db.applyMemorySchema();
            const mem = new MemoryManager(config, db.getRawDb());
            mem.initialize();

            // Collect qualified names from entry points and related nodes
            const qualifiedNames = [
              ...ctx.entryPoints.map((n: any) => n.qualifiedName),
              ...ctx.relatedNodes.slice(0, 5).map((n: any) => n.qualifiedName),
            ].filter(Boolean);

            const contextLimit = config.memoryContextLimit ?? 3;
            const contextThreshold = config.memoryContextThreshold ?? 0.3;

            // Try linked observations first, fall back to search
            let memResults = mem.getLinkedObservations(qualifiedNames, contextLimit, contextThreshold);
            if (memResults.length === 0) {
              // Fall back to searching by task description
              memResults = (await mem.search(args.task as string, { limit: contextLimit }))
                .filter(r => r.score >= contextThreshold);
            }

            if (memResults.length > 0) {
              lines.push('', '## Related Memory');
              for (const r of memResults.slice(0, contextLimit)) {
                const age = formatAge(r.observation.createdAt);
                lines.push(`- [${r.observation.kind}] ${r.observation.content} (${age})`);
              }
            }
          }
        } catch { /* memory is non-critical — don't fail context on memory errors */ }

        // Docs integration: surface relevant doc sections if enabled and docsContextLimit > 0
        try {
          const projectRoot2 = cg.getProjectRoot();
          const config2 = await (await import('../config')).loadConfig(projectRoot2);
          if (config2.enableDocs && config2.docsContextLimit > 0) {
            const db2 = cg.getDatabase();
            db2.applyDocsSchema();
            const { DocsQueries } = await import('../docs/queries');
            const docsQueries = new DocsQueries(db2.getRawDb(), projectRoot2);

            // Collect qualified names from entry points
            const qNames = ctx.entryPoints.map((n: any) => n.qualifiedName).filter(Boolean);

            if (qNames.length > 0) {
              // Find doc sections that reference these symbols
              const docRefs = docsQueries.getRefs({ qualifiedName: qNames[0] });
              const additionalRefs = qNames.slice(1, 5).flatMap(qn => docsQueries.getRefs({ qualifiedName: qn }));
              const allDocRefs = [...docRefs, ...additionalRefs];

              // Deduplicate by section ID and take top N
              const seenSections = new Set<string>();
              const uniqueRefs = allDocRefs.filter(r => {
                if (seenSections.has(r.sectionId)) return false;
                seenSections.add(r.sectionId);
                return r.confidence >= config2.docsContextThreshold;
              }).slice(0, config2.docsContextLimit);

              if (uniqueRefs.length > 0) {
                lines.push('', '## Related Documentation');
                for (const ref of uniqueRefs) {
                  const section = docsQueries.getSection(ref.sectionId);
                  if (section) {
                    const summary = section.section.summary ?? section.section.title;
                    lines.push(`- [${ref.refType}] ${summary} — ${section.section.filePath} (ID: ${ref.sectionId})`);
                  }
                }
              }
            }
          }
        } catch { /* docs is non-critical */ }

        // Data integration: surface relevant dataset schemas if enabled and dataContextLimit > 0
        try {
          const projectRoot3 = cg.getProjectRoot();
          const config3 = await (await import('../config')).loadConfig(projectRoot3);
          if (config3.enableData && config3.dataContextLimit > 0) {
            const db3 = cg.getDatabase();
            db3.applyDataSchema();

            // Find datasets referenced by the entry point files
            const entryFiles = ctx.entryPoints.map((n: any) => n.filePath).filter(Boolean);
            if (entryFiles.length > 0) {
              const placeholders = entryFiles.map(() => '?').join(', ');
              const dataRefs = db3.getRawDb().all(
                `SELECT DISTINCT d.id, d.file_path, d.row_count, d.column_count
                 FROM data_code_refs r JOIN data_datasets d ON r.dataset_id = d.id
                 WHERE r.qualified_name IN (${placeholders})`,
                entryFiles,
              ) as any[];

              if (dataRefs.length > 0) {
                const { DataQueries } = await import('../data/queries');
                const dq = new DataQueries(db3.getRawDb());
                const limit = config3.dataContextLimit;

                lines.push('', '## Related Data');
                for (const ref of dataRefs.slice(0, limit)) {
                  const info = dq.describeDataset(ref.id);
                  if (info) {
                    const colSummary = info.columns.map(c => `${c.name}:${c.inferredType}`).join(', ');
                    lines.push(`- **${ref.id}** (${ref.file_path}) — ${ref.row_count} rows, ${ref.column_count} cols`);
                    lines.push(`  Schema: ${colSummary}`);
                  }
                }
              }
            }
          }
        } catch { /* data is non-critical */ }

        // Context savings estimation
        const graphTokens = lines.join('\n').length / 4; // rough token estimate
        const uniqueFiles = new Set([
          ...ctx.entryPoints.map((n: any) => n.filePath),
          ...ctx.relatedNodes.map((n: any) => n.filePath),
        ]);
        if (uniqueFiles.size > 0) {
          const naiveTokens = estimateFileTokens(cg.getProjectRoot(), [...uniqueFiles]);
          if (naiveTokens > 0) {
            const savingsPct = Math.round((1 - graphTokens / naiveTokens) * 100);
            if (savingsPct > 0) {
              lines.push('', `---`, `Context savings: ~${Math.round(graphTokens)} tokens (graph) vs ~${naiveTokens} tokens (full files) — ${savingsPct}% reduction`);
            }
          }
        }

        return lines.join('\n');
      }

      case 'kirograph_callers': {
        const limit = clampLimit(args.limit as number | undefined, 20);
        const results = cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const callers = await cg.getCallers(node.id, limit);
        if (callers.length === 0) return `No callers found for \`${node.name}\`.`;
        return `Callers of \`${node.name}\`:\n` + callers.map(n =>
          `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`
        ).join('\n');
      }

      case 'kirograph_callees': {
        const limit = clampLimit(args.limit as number | undefined, 20);
        const results = cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const callees = await cg.getCallees(node.id, limit);
        if (callees.length === 0) return `\`${node.name}\` doesn't call any indexed symbols.`;
        return `\`${node.name}\` calls:\n` + callees.map(n =>
          `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`
        ).join('\n');
      }

      case 'kirograph_impact': {
        const results = cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const affected = await cg.getImpactRadius(node.id, (args.depth as number) ?? 2);
        if (affected.length === 0) return `No dependents found for \`${node.name}\`.`;

        let output = `Changing \`${node.name}\` may affect ${affected.length} symbol(s):\n` +
          affected.map(n => `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');

        // Memory integration: surface observations linked to the target symbol
        try {
          const { loadConfig } = await import('../config');
          const projectRoot = cg.getProjectRoot();
          const config = await loadConfig(projectRoot);
          if (config.enableMemory) {
            const { MemoryManager } = await import('../memory/index');
            const db = cg.getDatabase();
            db.applyMemorySchema();
            const mem = new MemoryManager(config, db.getRawDb());
            mem.initialize();

            const contextLimit = config.memoryContextLimit ?? 3;
            const contextThreshold = config.memoryContextThreshold ?? 0.3;
            const memResults = mem.getLinkedObservations(
              [node.qualifiedName],
              contextLimit,
              contextThreshold
            );

            if (memResults.length > 0) {
              output += '\n\nRelated Memory:';
              for (const r of memResults) {
                const age = formatAge(r.observation.createdAt);
                output += `\n- [${r.observation.kind}] ${r.observation.content} (${age})`;
              }
            }
          }
        } catch { /* memory is non-critical */ }

        return output;
      }

      case 'kirograph_node': {
        const results = cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const lines = [
          `${mapKind(node.kind)} \`${node.name}\``,
          `File: ${node.filePath}:${node.startLine}-${node.endLine}`,
          `Qualified: ${node.qualifiedName}`,
          node.signature ? `Signature: ${node.signature}` : '',
          node.docstring ? `Docs: ${node.docstring}` : '',
        ].filter(Boolean);
        if (args.includeCode) {
          const src = cg.getNodeSource(node);
          if (src) lines.push('', '```', src, '```');
        }
        return lines.join('\n');
      }

      case 'kirograph_status': {
        const stats = await cg.getStats();
        const langLine = Object.entries(stats.filesByLanguage)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        const dbMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(2);
        const semanticLines = stats.embeddingsEnabled
          ? [
              `  Semantic search: enabled`,
              `  Semantic model:  ${stats.embeddingModel}`,
              `  Semantic engine: ${
                stats.semanticEngine === 'sqlite-vec' ? `sqlite-vec (${stats.vecIndexCount} entries in ANN index)` :
                stats.semanticEngine === 'orama'      ? `orama hybrid (${stats.vecIndexCount} docs in index)` :
                stats.semanticEngine === 'pglite'     ? `pglite+pgvector (${stats.vecIndexCount} rows in DB)` :
                stats.semanticEngine === 'lancedb'    ? `lancedb (${stats.vecIndexCount} entries in ANN index)` :
                stats.semanticEngine === 'qdrant'     ? `qdrant (${stats.vecIndexCount} points in collection)` :
                stats.semanticEngine === 'typesense'  ? `typesense (${stats.vecIndexCount} documents in collection)` :
                'in-process cosine'
              }`,
              `  Embeddings:      ${stats.embeddingCount} / ${stats.embeddableNodeCount || stats.nodes} embeddable symbols`,
              ...(stats.engineFallback ? [`  ⚠ Engine fallback: ${stats.engineFallback}`] : []),
            ]
          : [`  Semantic search: disabled`];
        const frameworkLine = stats.frameworks.length > 0
          ? `  Frameworks: ${stats.frameworks.join(', ')}`
          : `  Frameworks: none detected`;
        const archLine = stats.architectureEnabled
          ? stats.architectureStats
            ? `  Architecture: enabled — ${stats.architectureStats.packages} packages, ${stats.architectureStats.layers} layers, ${stats.architectureStats.packageDeps} deps`
            : `  Architecture: enabled (not yet analyzed — run kirograph index)`
          : `  Architecture: disabled`;

        // Docs stats
        let docsLine = '  Documentation: disabled';
        try {
          const { loadConfig: loadCfg } = await import('../config');
          const cfg = await loadCfg(cg.getProjectRoot());
          if (cfg.enableDocs) {
            const db = cg.getDatabase();
            db.applyDocsSchema();
            const rawDb = db.getRawDb();
            const docFiles = rawDb.get('SELECT COUNT(DISTINCT file_path) as cnt FROM doc_sections')?.cnt ?? 0;
            const docSections = rawDb.get('SELECT COUNT(*) as cnt FROM doc_sections')?.cnt ?? 0;
            const docRefs = rawDb.get('SELECT COUNT(*) as cnt FROM doc_code_refs')?.cnt ?? 0;
            docsLine = `  Documentation: enabled — ${docFiles} files, ${docSections} sections, ${docRefs} code refs`;
          }
        } catch { /* non-critical */ }

        // Data stats
        let dataLine = '  Data: disabled';
        try {
          const { loadConfig: loadCfg2 } = await import('../config');
          const cfg2 = await loadCfg2(cg.getProjectRoot());
          if (cfg2.enableData) {
            const rawDb2 = cg.getDatabase().getRawDb();
            cg.getDatabase().applyDataSchema();
            const datasetCount = rawDb2.get('SELECT COUNT(*) as cnt FROM data_datasets')?.cnt ?? 0;
            if (datasetCount > 0) {
              const totalRows = rawDb2.get('SELECT SUM(row_count) as total FROM data_datasets')?.total ?? 0;
              const totalCols = rawDb2.get('SELECT SUM(column_count) as total FROM data_datasets')?.total ?? 0;
              const totalSize = rawDb2.get('SELECT SUM(file_size) as total FROM data_datasets')?.total ?? 0;
              const sizeMb = (totalSize / 1024 / 1024).toFixed(2);
              dataLine = `  Data: enabled — ${datasetCount} datasets, ${totalRows.toLocaleString()} rows, ${totalCols} columns (${sizeMb} MB source)`;
            } else {
              dataLine = `  Data: enabled (no datasets indexed yet — run kirograph index)`;
            }
          }
        } catch { /* non-critical */ }

        // Sync state warning
        const threshold = stats.syncWarningThreshold ?? 10;
        const pendingFiles: number = stats.pendingFiles ?? 0;
        const syncRunning: boolean = stats.syncRunning ?? false;
        const syncLines: string[] = [];
        if (syncRunning) {
          syncLines.push(`  ⚠ Sync is currently running in the background.`);
        }
        if (threshold > 0 && pendingFiles >= threshold) {
          syncLines.push(
            `  ⚠ Index may be incomplete — ${pendingFiles} file${pendingFiles !== 1 ? 's' : ''} pending sync.` +
            (syncRunning ? ' Sync is running in background.' : ' Run `kirograph sync` to update.') +
            ` Would you like to wait before proceeding?`
          );
        }

        // Token savings summary
        const tracker = new TokenTracker(cg.getProjectRoot());
        const gainStats = tracker.getStats('session');
        const gainLines: string[] = [];
        if (gainStats.totalCommands > 0) {
          gainLines.push(`  Compression: ${gainStats.totalCommands} commands, ${gainStats.savingsPercent}% avg savings (${gainStats.totalSaved.toLocaleString()} tokens saved this session)`);
        }

        return [
          `KiroGraph Status`,
          `  Project: ${cg.getProjectRoot()}`,
          `  Files indexed: ${stats.files}`,
          `  Symbols: ${stats.nodes}`,
          `  Relationships: ${stats.edges}`,
          `  By kind: ${Object.entries(stats.nodesByKind).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          langLine ? `  By language: ${langLine}` : '',
          frameworkLine,
          archLine,
          docsLine,
          dataLine,
          `  DB size: ${dbMb} MB`,
          ...semanticLines,
          ...syncLines,
          ...gainLines,
        ].filter(Boolean).join('\n');
      }

      case 'kirograph_files': {
        const format = (args.format as string) ?? 'tree';
        const includeMetadata = args.includeMetadata !== false;
        const tree = cg.getFiles({
          filterPath: args.filterPath as string | undefined,
          pattern: args.pattern as string | undefined,
          maxDepth: args.maxDepth as number | undefined,
        });

        if (format === 'flat') {
          const flat: string[] = [];
          function flattenTree(nodes: import('../index').FileTreeNode[]): void {
            for (const node of nodes) {
              if (node.type === 'file') {
                const meta = includeMetadata && node.language ? ` [${node.language}${node.symbolCount ? ` · ${node.symbolCount}` : ''}]` : '';
                flat.push(`${node.path}${meta}`);
              }
              if (node.children?.length) flattenTree(node.children);
            }
          }
          flattenTree(tree);
          return flat.length > 0 ? flat.join('\n') : 'No indexed files found.';
        }

        if (format === 'grouped') {
          const groups = new Map<string, import('../index').FileTreeNode[]>();
          function groupTree(nodes: import('../index').FileTreeNode[]): void {
            for (const node of nodes) {
              if (node.type === 'file') {
                const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
                if (!groups.has(dir)) groups.set(dir, []);
                groups.get(dir)!.push(node);
              }
              if (node.children?.length) groupTree(node.children);
            }
          }
          groupTree(tree);
          const lines: string[] = [];
          for (const [dir, files] of [...groups.entries()].sort()) {
            lines.push(`${dir}/`);
            for (const f of files) {
              const meta = includeMetadata && f.language ? ` [${f.language}${f.symbolCount ? ` · ${f.symbolCount}` : ''}]` : '';
              lines.push(`  ${f.name}${meta}`);
            }
          }
          return lines.length > 0 ? lines.join('\n') : 'No indexed files found.';
        }

        if (format === 'compact') {
          // rtk-style compact: directory summary with file counts and language breakdown
          const dirStats = new Map<string, { files: number; symbols: number; langs: Map<string, number> }>();
          function compactTree(nodes: import('../index').FileTreeNode[]): void {
            for (const node of nodes) {
              if (node.type === 'file') {
                const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';
                const stat = dirStats.get(dir) || { files: 0, symbols: 0, langs: new Map() };
                stat.files++;
                stat.symbols += node.symbolCount || 0;
                if (node.language) stat.langs.set(node.language, (stat.langs.get(node.language) || 0) + 1);
                dirStats.set(dir, stat);
              }
              if (node.children?.length) compactTree(node.children);
            }
          }
          compactTree(tree);
          const totalFiles = [...dirStats.values()].reduce((s, d) => s + d.files, 0);
          const totalSymbols = [...dirStats.values()].reduce((s, d) => s + d.symbols, 0);
          const lines: string[] = [`${totalFiles} files, ${totalSymbols} symbols in ${dirStats.size} directories:\n`];
          for (const [dir, stat] of [...dirStats.entries()].sort()) {
            const langSummary = [...stat.langs.entries()].map(([l, c]) => `${l}:${c}`).join(' ');
            lines.push(`${dir}/ (${stat.files} files, ${stat.symbols} symbols) ${langSummary}`);
          }
          return lines.join('\n');
        }

        // Default: tree format
        const lines: string[] = [];
        function renderTree(nodes: import('../index').FileTreeNode[], prefix: string): void {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const isLast = i === nodes.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            const meta = includeMetadata && node.type === 'file' && node.language
              ? `  [${node.language}${node.symbolCount ? ` · ${node.symbolCount} symbols` : ''}]`
              : '';
            lines.push(`${prefix}${connector}${node.name}${meta}`);
            if (node.children?.length) renderTree(node.children, childPrefix);
          }
        }
        renderTree(tree, '');
        return lines.length > 0 ? lines.join('\n') : 'No indexed files found.';
      }

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

      case 'kirograph_flows': {
        const { getExecutionFlows, traceFlow, detectEntryPoints } = await import('../graph/flows');
        const db = cg.getDatabase();

        if (args.entryPoint) {
          // Trace from a specific symbol
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

        // Auto-detect entry points and trace flows
        const flows = getExecutionFlows(db, {
          maxFlows: (args.maxFlows as number) ?? 10,
          maxDepth: (args.maxDepth as number) ?? 10,
        });

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

      case 'kirograph_communities': {
        const { detectCommunities } = await import('../graph/communities');
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

      case 'kirograph_refactor': {
        const { renamePreview, suggestRefactorings } = await import('../graph/refactor');
        const db = cg.getDatabase();
        const mode = args.mode as string;

        if (mode === 'rename') {
          if (!args.symbol) return 'Error: "symbol" parameter is required for rename mode.';
          const preview = renamePreview(db, args.symbol as string);
          if (!preview) return `Symbol "${args.symbol}" not found in index.`;

          const lines = [
            `## Rename Preview: \`${preview.symbol}\``,
            `Kind: ${preview.kind}`,
            `Defined at: ${preview.filePath}:${preview.line}`,
            `Total references: ${preview.totalReferences}`,
            '',
          ];

          if (preview.references.length === 0) {
            lines.push('No references found — this symbol can be safely renamed without affecting other code.');
          } else {
            // Group by file
            const byFile = new Map<string, typeof preview.references>();
            for (const ref of preview.references) {
              if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
              byFile.get(ref.filePath)!.push(ref);
            }

            for (const [file, refs] of byFile) {
              lines.push(`### ${file} (${refs.length} references)`);
              for (const ref of refs.slice(0, 10)) {
                lines.push(`- Line ${ref.line}: \`${ref.context}\` (${ref.edgeKind})`);
              }
              if (refs.length > 10) lines.push(`  …and ${refs.length - 10} more`);
              lines.push('');
            }
          }

          return lines.join('\n');
        }

        if (mode === 'suggest') {
          const suggestions = suggestRefactorings(db, (args.limit as number) ?? 10);
          if (suggestions.length === 0) return 'No refactoring suggestions — the codebase structure looks clean.';

          const lines = [`## Refactoring Suggestions (${suggestions.length})`, ''];
          for (const s of suggestions) {
            const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢';
            lines.push(`${icon} **${s.type}** [${s.priority}]: ${s.description}`);
            lines.push(`   Rationale: ${s.rationale}`);
            if (s.symbols.length > 0) {
              lines.push(`   Symbols: ${s.symbols.slice(0, 3).join(', ')}`);
            }
            lines.push('');
          }

          return lines.join('\n');
        }

        return 'Unknown mode. Use "rename" or "suggest".';
      }

      // ── Memory tools ────────────────────────────────────────────────────────

      case 'kirograph_mem_search': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase();
        db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();

        const results = await mem.search(args.query as string, {
          limit: (args.limit as number) ?? 10,
          kind: args.kind as any,
          sessionId: args.sessionId as string | undefined,
          asOf: args.asOf as number | undefined,
        });

        if (results.length === 0) return `No memory observations found for "${args.query}".`;

        return results.map((r, i) => {
          const age = formatAge(r.observation.createdAt);
          return `${i + 1}. [${r.observation.kind}] ${r.observation.content} (${age})`;
        }).join('\n');
      }

      case 'kirograph_mem_store': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase();
        db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();

        const id = await mem.store({
          content: args.content as string,
          kind: (args.kind as any) ?? 'note',
          source: 'agent',
        });

        if (!id) return 'Observation already exists (duplicate content).';
        return `Stored observation ${id} [${(args.kind as string) ?? 'note'}]`;
      }

      case 'kirograph_mem_timeline': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase();
        db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();

        const { sessions, observations } = mem.timeline({
          limit: (args.limit as number) ?? 5,
          sessionId: args.sessionId as string | undefined,
        });

        if (sessions.length === 0) return 'No memory sessions found.';

        const lines: string[] = [];
        for (const session of sessions) {
          const start = new Date(session.startedAt).toISOString().slice(0, 16).replace('T', ' ');
          const status = session.endedAt ? 'ended' : 'active';
          const obs = observations.get(session.id) ?? [];
          lines.push(`## ${start} [${session.ide ?? 'unknown'}] (${status}, ${obs.length} observations)`);
          for (const o of obs.slice(0, 5)) {
            lines.push(`  - [${o.kind}] ${o.content.slice(0, 120)}`);
          }
          if (obs.length > 5) lines.push(`  …and ${obs.length - 5} more`);
        }
        return lines.join('\n');
      }

      case 'kirograph_mem_status': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase();
        db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();

        const stats = mem.getStats();
        const lines = [
          'KiroGraph Memory Status',
          `  Sessions: ${stats.sessions} (${stats.activeSessions} active)`,
          `  Observations: ${stats.observations}`,
          `  Symbol links: ${stats.links}`,
          `  Embeddings: ${stats.vectors} / ${stats.embeddableCount}`,
          `  Model mismatch: ${stats.modelMismatch ? '⚠ yes — run kirograph mem reembed' : 'no'}`,
          `  Caveman compression: ${config.cavemanMode !== 'off' ? config.cavemanMode : 'off (storing raw)'}`,
        ];
        return lines.join('\n');
      }

      // ── Docs tools ────────────────────────────────────────────────────────────

      case 'kirograph_docs_toc': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

        const { DocsQueries } = await import('../docs/queries');
        const db = cg.getDatabase();
        db.applyDocsSchema();
        const docs = new DocsQueries(db.getRawDb(), projectRoot);

        const toc = docs.getToc({ file: args.file as string | undefined, tree: args.tree as boolean | undefined });
        if (toc.length === 0) return args.file ? `No sections found in "${args.file}".` : 'No documentation indexed. Run kirograph index.';

        const lines: string[] = [];
        const renderEntry = (entry: any, indent: string) => {
          const prefix = '#'.repeat(entry.level || 1);
          const summary = entry.summary ? ` — ${entry.summary}` : '';
          lines.push(`${indent}${prefix} ${entry.title}${summary}`);
          lines.push(`${indent}  ID: ${entry.id}`);
          if (entry.children?.length) {
            for (const child of entry.children) renderEntry(child, indent + '  ');
          }
        };

        if (args.tree) {
          for (const entry of toc) renderEntry(entry, '');
        } else {
          for (const entry of toc) {
            const prefix = '#'.repeat(entry.level || 1);
            const summary = entry.summary ? ` — ${entry.summary}` : '';
            lines.push(`${prefix} ${entry.title} [${entry.filePath}]${summary}`);
            lines.push(`  ID: ${entry.id}`);
          }
        }

        return lines.join('\n');
      }

      case 'kirograph_docs_search': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

        const { DocsQueries } = await import('../docs/queries');
        const db = cg.getDatabase();
        db.applyDocsSchema();
        const docs = new DocsQueries(db.getRawDb(), projectRoot, config);

        const results = await docs.searchSections(args.query as string, {
          file: args.file as string | undefined,
          limit: (args.limit as number) ?? 10,
        });

        if (results.length === 0) return `No documentation sections found matching "${args.query}".`;

        return results.map((r, i) => {
          const summary = r.section.summary ? `\n  ${r.section.summary}` : '';
          return `${i + 1}. ${r.section.title} [${r.section.filePath}]${summary}\n  ID: ${r.section.id}`;
        }).join('\n\n');
      }

      case 'kirograph_docs_section': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

        const { DocsQueries } = await import('../docs/queries');
        const db = cg.getDatabase();
        db.applyDocsSchema();
        const docs = new DocsQueries(db.getRawDb(), projectRoot);

        const result = docs.getSection(args.id as string, { context: args.context as boolean | undefined });
        if (!result) return `Section "${args.id}" not found.`;

        const lines: string[] = [];

        if (result.ancestors?.length) {
          lines.push('Breadcrumb: ' + result.ancestors.map(a => a.title).join(' > ') + ' > ' + result.section.title);
          lines.push('');
        }

        lines.push(result.content);

        if (result.children?.length) {
          lines.push('', '## Child sections:');
          for (const child of result.children) {
            const summary = child.summary ? ` — ${child.summary}` : '';
            lines.push(`  - ${child.title}${summary} (ID: ${child.id})`);
          }
        }

        return lines.join('\n');
      }

      case 'kirograph_docs_outline': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

        const { DocsQueries } = await import('../docs/queries');
        const db = cg.getDatabase();
        db.applyDocsSchema();
        const docs = new DocsQueries(db.getRawDb(), projectRoot);

        const outline = docs.getOutline(args.file as string);
        if (outline.length === 0) return `No sections found in "${args.file}". Is the file indexed?`;

        const lines: string[] = [`Outline: ${args.file}`, ''];
        const renderOutline = (entries: any[], indent: string) => {
          for (const entry of entries) {
            const summary = entry.summary ? ` — ${entry.summary}` : '';
            lines.push(`${indent}${'#'.repeat(entry.level || 1)} ${entry.title}${summary}`);
            if (entry.children?.length) renderOutline(entry.children, indent + '  ');
          }
        };
        renderOutline(outline, '');

        return lines.join('\n');
      }

      case 'kirograph_docs_refs': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableDocs) return 'Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json and run kirograph index.';

        const { DocsQueries } = await import('../docs/queries');
        const db = cg.getDatabase();
        db.applyDocsSchema();
        const docs = new DocsQueries(db.getRawDb(), projectRoot);

        const refs = docs.getRefs({
          sectionId: args.sectionId as string | undefined,
          qualifiedName: args.nodeId as string | undefined,
        });

        if (refs.length === 0) {
          if (args.sectionId) return `No code references found in section "${args.sectionId}".`;
          if (args.nodeId) return `No documentation sections reference "${args.nodeId}".`;
          return 'Provide either sectionId or nodeId to look up cross-references.';
        }

        return refs.map(r => {
          const direction = args.sectionId ? `→ ${r.qualifiedName}` : `← ${r.sectionTitle ?? r.sectionId}`;
          return `[${r.refType}] ${direction} (confidence: ${r.confidence.toFixed(2)})`;
        }).join('\n');
      }

      // ── Data tools ────────────────────────────────────────────────────────────

      case 'kirograph_data_list': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());
        const datasets = dq.listDatasets();

        if (datasets.length === 0) return 'No datasets indexed. Run kirograph index or kirograph data reindex.';

        return datasets.map(ds => {
          const sizeMb = (ds.fileSize / 1024 / 1024).toFixed(2);
          return `${ds.id} (${ds.format})\n  File: ${ds.filePath}\n  Rows: ${ds.rowCount.toLocaleString()} | Columns: ${ds.columnCount} | Size: ${sizeMb} MB`;
        }).join('\n\n');
      }

      case 'kirograph_data_describe': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        if (args.column) {
          const col = dq.describeColumn(args.dataset as string, args.column as string);
          if (!col) return `Column "${args.column}" not found in dataset "${args.dataset}".`;
          return [
            `Column: ${col.name}`,
            `Type: ${col.inferredType}`,
            `Nullable: ${col.nullable} (${(col.nullPct * 100).toFixed(1)}% null)`,
            `Cardinality: ${col.cardinality}`,
            col.minValue ? `Min: ${col.minValue}` : '',
            col.maxValue ? `Max: ${col.maxValue}` : '',
            col.meanValue !== null ? `Mean: ${col.meanValue.toFixed(2)}` : '',
            `Samples: ${col.sampleValues.join(', ')}`,
          ].filter(Boolean).join('\n');
        }

        const result = dq.describeDataset(args.dataset as string);
        if (!result) return `Dataset "${args.dataset}" not found. Use kirograph_data_list to see available datasets.`;

        const lines = [
          `Dataset: ${result.dataset.id} (${result.dataset.format})`,
          `File: ${result.dataset.filePath}`,
          `Rows: ${result.dataset.rowCount.toLocaleString()} | Columns: ${result.dataset.columnCount}`,
          '',
          'Columns:',
        ];
        for (const col of result.columns) {
          const nullInfo = col.nullable ? ` (${(col.nullPct * 100).toFixed(0)}% null)` : '';
          const samples = col.sampleValues.length > 0 ? ` — samples: ${col.sampleValues.slice(0, 3).join(', ')}` : '';
          const summary = col.summary ? ` [${col.summary}]` : '';
          lines.push(`  ${col.name}: ${col.inferredType}${nullInfo} [${col.cardinality} distinct]${samples}${summary}`);
        }

        // Validation rules
        const rules = dq.validationRules(args.dataset as string);
        if (rules && rules.length > 0) {
          lines.push('', 'Validation rules:');
          for (const r of rules.slice(0, 10)) {
            lines.push(`  ${r.column}: ${r.rules.join('; ')}`);
          }
        }

        // Sample data hints
        const hints = dq.sampleHints(args.dataset as string);
        if (hints && hints.length > 0) {
          lines.push('', 'Sample data hints:');
          for (const h of hints.slice(0, 10)) {
            lines.push(`  ${h.column}: ${h.hint}`);
          }
        }

        return lines.join('\n');
      }

      case 'kirograph_data_query': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        const result = dq.queryRows(args.dataset as string, {
          filters: args.filters as any[],
          columns: args.columns as string[],
          limit: (args.limit as number) ?? 100,
          offset: (args.offset as number) ?? 0,
        });

        if (!result) return `Dataset "${args.dataset}" not found.`;
        if (result.rows.length === 0) return `No rows match the given filters (${result.totalMatching} total in dataset).`;

        const header = `${result.rows.length} rows returned (${result.totalMatching} total matching):\n`;
        const rowStrs = result.rows.slice(0, 50).map((row, i) => {
          const vals = Object.entries(row).map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ');
          return `  ${i + 1}. ${vals}`;
        });
        if (result.rows.length > 50) rowStrs.push(`  …and ${result.rows.length - 50} more rows`);
        let response = header + rowStrs.join('\n');

        // Token budget enforcement
        const maxChars = config.dataMaxResponseTokens * 4;
        if (response.length > maxChars) {
          response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
        }

        // Anti-loop detection
        response = this.checkPaginationLoop(args.dataset as string, args.offset as number | undefined, response);

        return response;
      }

      case 'kirograph_data_aggregate': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        const result = dq.aggregate(args.dataset as string, {
          groupBy: (args.groupBy as string[]) ?? [],
          metrics: (args.metrics as any[]) ?? [],
          filters: args.filters as any[],
        });

        if (!result) return `Dataset "${args.dataset}" not found.`;
        if (result.rows.length === 0) return 'No results (empty dataset or all rows filtered out).';

        const keys = Object.keys(result.rows[0]);
        const header = keys.join(' | ');
        const separator = keys.map(() => '---').join(' | ');
        const rows = result.rows.slice(0, 100).map(row => keys.map(k => row[k] ?? 'null').join(' | '));

        let response = `${header}\n${separator}\n${rows.join('\n')}${result.rows.length > 100 ? `\n…and ${result.rows.length - 100} more groups` : ''}`;

        // Token budget enforcement
        const maxChars = config.dataMaxResponseTokens * 4;
        if (response.length > maxChars) {
          response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
        }

        return response;
      }

      case 'kirograph_data_search': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        const cols = dq.searchColumns(args.dataset as string, args.query as string);
        if (cols.length === 0) return `No columns matching "${args.query}" in dataset "${args.dataset}".`;

        return cols.map(c => {
          const samples = c.sampleValues.length > 0 ? ` — samples: ${c.sampleValues.slice(0, 3).join(', ')}` : '';
          return `${c.name}: ${c.inferredType} [${c.cardinality} distinct]${samples}`;
        }).join('\n');
      }

      case 'kirograph_data_join': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        try {
          const result = dq.join({
            left: args.left as string,
            right: args.right as string,
            leftColumn: args.leftColumn as string,
            rightColumn: args.rightColumn as string,
            type: (args.type as any) ?? 'inner',
            columns: args.columns as string[] | undefined,
            limit: args.limit as number | undefined,
          });

          if (!result) return `Dataset not found. Verify both dataset IDs with kirograph_data_list.`;

          const joinTypeStr = String(args.type ?? 'inner').toUpperCase();
          const header = `Join: ${args.left}.${args.leftColumn} ${joinTypeStr} JOIN ${args.right}.${args.rightColumn}\nMatching rows: ${result.totalMatching} (showing ${result.rows.length})`;
          if (result.rows.length === 0) return `${header}\n\nNo matching rows.`;

          const lines = result.rows.map(r => JSON.stringify(r));
          let response = `${header}\n\n${lines.join('\n')}`;

          // Token budget enforcement
          const maxChars = config.dataMaxResponseTokens * 4;
          if (response.length > maxChars) {
            response = response.slice(0, maxChars) + '\n\n[truncated: response exceeded token budget]';
          }

          return response;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'kirograph_data_correlations': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        const pairs = dq.correlations(args.dataset as string, args.threshold as number | undefined);
        if (pairs === null) return `Dataset "${args.dataset}" not found.`;
        if (pairs.length === 0) return `No correlations above threshold ${args.threshold ?? 0.3} found. The dataset may have fewer than 2 numeric columns or no significant correlations.`;

        const lines = pairs.map(p =>
          `${p.column1} ↔ ${p.column2}: ${p.correlation > 0 ? '+' : ''}${p.correlation.toFixed(4)} (${p.strength})`
        );
        return `Correlations for "${args.dataset}" (threshold: ${args.threshold ?? 0.3}):\n\n${lines.join('\n')}`;
      }

      case 'kirograph_data_quality': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableData) return 'Data indexing is not enabled. Set enableData: true in .kirograph/config.json and run kirograph index.';

        const { DataQueries } = await import('../data/queries');
        const db = cg.getDatabase();
        db.applyDataSchema();
        const dq = new DataQueries(db.getRawDb());

        const quality = dq.quality(args.dataset as string);
        if (quality === null) return `Dataset "${args.dataset}" not found.`;
        if (quality.length === 0) return `No quality issues detected in "${args.dataset}". All columns look healthy.`;

        const lines = quality.map(q =>
          `${q.column} (risk: ${(q.riskScore * 100).toFixed(0)}%): ${q.issues.join('; ')}`
        );
        return `Quality report for "${args.dataset}" (${quality.length} columns with issues):\n\n${lines.join('\n')}`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }
}
