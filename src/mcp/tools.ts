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
        topicKey: { type: 'string', description: "Stable semantic key for this observation (e.g. 'architecture/auth-model'). Enables addressing by concept." },
        reviewAfter: { type: 'number', description: 'Epoch ms: schedule this observation for re-evaluation after this timestamp.' },
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
  // ── Engram-parity mem tools ──────────────────────────────────────────────────
  {
    name: 'kirograph_mem_review',
    description: 'List observations past their review_after date — stale facts the agent should re-evaluate, update, or supersede.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_mem_mark_reviewed',
    description: 'Mark an observation as reviewed — clears its review_after date.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Observation ID' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        reason: { type: 'string', description: 'Explanation for the relation' },
        evidence: { type: 'string', description: 'Supporting evidence text' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
        reason: { type: 'string', description: 'Reasoning for judgment' },
        evidence: { type: 'string', description: 'Supporting evidence' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['relationId', 'relation', 'confidence'],
    },
  },
  {
    name: 'kirograph_mem_capture',
    description: 'Extract and store structured learnings from a freeform text block. Looks for ## Key Learnings, ## Observations, ## Decisions, ## Key Changes sections and saves each bullet as a separate observation.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text block with structured sections' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kirograph_mem_save_prompt',
    description: 'Save the current user prompt to session memory for context reconstruction.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Prompt content to save' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kirograph_mem_suggest_topic_key',
    description: 'Suggest a stable topic_key for an observation based on its kind and content. Returns a deterministic slug like "architecture/auth-model".',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['decision', 'error', 'pattern', 'architecture', 'summary', 'note'], description: 'Observation kind' },
        title: { type: 'string', description: 'Short title or first sentence of the observation' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'kirograph_mem_conflicts_scan',
    description: 'Scan recent observations for potential conflicts using FTS similarity. Returns candidate pairs that may need a relation established via kirograph_mem_compare.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max observations to scan (default: 50)', default: 50 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  // ── Wiki tools (require enableWiki=true) ────────────────────────────────────
  {
    name: 'kirograph_wiki_ingest',
    description: 'Returns an ingest prompt (SCHEMA + MANIFEST + source content) for the LLM to produce a WIKI_DIFF. Call kirograph_wiki_apply_diff with the result.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source content to ingest (markdown, notes, ADR text, etc.)' },
        sourceName: { type: 'string', description: 'Name or path of the source (e.g. "ADR-001.md")', default: 'source' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['source'],
    },
  },
  {
    name: 'kirograph_wiki_apply_diff',
    description: 'Apply a WIKI_DIFF string (produced by the LLM after kirograph_wiki_ingest) to the wiki filesystem and SQLite index.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'WIKI_DIFF string with WIKI_DIFF_START/END blocks' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['diff'],
    },
  },
  {
    name: 'kirograph_wiki_search',
    description: 'Full-text search over wiki pages. Returns page slugs, titles, and previews ranked by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)', default: 5 },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_wiki_page',
    description: 'Retrieve the full markdown content of a wiki page by slug.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug (e.g. "AuthService", "arch/auth-model")' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'kirograph_wiki_lint',
    description: 'Health check the wiki for broken links, orphan pages, stale sources, and potential contradictions between pages.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_wiki_list',
    description: 'List all wiki pages with slug, title, source count, and last updated date.',
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
  // ── Security tools (require enableSecurity=true) ────────────────────────────
  {
    name: 'kirograph_security',
    description: 'Security overview: vulnerability counts, affected/not_affected verdicts, stale data warnings. Requires enableSecurity=true and enableArchitecture=true.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_vulns',
    description: 'List vulnerabilities with reachability verdicts, severity, and affected components. Supports on-demand refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Filter by severity level', enum: ['critical', 'high', 'medium', 'low'] },
        verdict: { type: 'string', description: 'Filter by reachability verdict', enum: ['affected', 'not_affected', 'under_investigation'] },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        refresh: { type: 'boolean', description: 'Trigger fresh vulnerability enrichment before listing (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_vuln_add',
    description: 'Manually register a CVE against a dependency without querying external databases.',
    inputSchema: {
      type: 'object',
      properties: {
        cveId: { type: 'string', description: 'CVE identifier (e.g., "CVE-2023-12345")' },
        package: { type: 'string', description: 'Package name to associate the CVE with' },
        severity: { type: 'number', description: 'CVSS v3.1 base score (optional)' },
        summary: { type: 'string', description: 'Vulnerability summary (optional)' },
        fixedVersion: { type: 'string', description: 'Version that fixes the vulnerability (optional)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['cveId', 'package'],
    },
  },
  {
    name: 'kirograph_vuln_suppress',
    description: 'Suppress a CVE so it no longer appears in vulnerability reports (mark as false positive or accepted risk). Suppressions are stored in .kirograph/security-suppressions.json.',
    inputSchema: {
      type: 'object',
      properties: {
        cveId: { type: 'string', description: 'CVE identifier to suppress (e.g., "CVE-2024-1234")' },
        reason: { type: 'string', description: 'Reason for suppression (optional)' },
        expires: { type: 'string', description: 'Expiry date in ISO format after which the suppression is removed (e.g. "2026-12-31", optional)' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['cveId'],
    },
  },
  {
    name: 'kirograph_sbom',
    description: 'Generate and return CycloneDX 1.5 SBOM JSON for the project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_vex',
    description: 'Generate and return CycloneDX 1.5 VEX JSON with reachability verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_reachability',
    description: 'Check reachability for a specific dependency or vulnerability. Returns verdict, paths, and impact summary.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Dependency name or CVE ID to check reachability for' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'kirograph_staleness',
    description: 'Check dependency freshness — identifies packages significantly behind their latest published version.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Only return packages with staleness_score >= threshold (default: 0.3)', default: 0.3 },
        refresh: { type: 'boolean', description: 'Fetch latest version info from registries before listing (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_licenses',
    description: 'Show dependency licenses and check against the configured license policy (deny/warn lists). Supports wildcard patterns (e.g. GPL-* matches GPL-2.0, GPL-3.0-only).',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'boolean', description: 'Return only policy violations (default: false)', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_attack_surface',
    description: 'Map the attack surface: all HTTP routes and their paths to vulnerable dependencies, with hop count, authentication status, and risk score.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max routes to return (default: 20)', default: 20 },
        publicOnly: { type: 'boolean', description: 'Only return public/unauthenticated routes', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_secrets',
    description: 'Scan for hardcoded secrets and credentials, enriched with call-graph blast radius showing which entry points reach the secret.',
    inputSchema: {
      type: 'object',
      properties: {
        includeTests: { type: 'boolean', description: 'Include test files in scan', default: false },
        severity: { type: 'string', description: 'Filter by severity: critical, high, medium, low', enum: ['critical', 'high', 'medium', 'low'] },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_security_flows',
    description: 'SAST-lite: detect dangerous data flows (SQL injection, dangerous eval, unsafe deserialization, path traversal, weak crypto). Each finding tagged with OWASP Top 10 category.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type: sql, eval, deserialize, path, crypto, all', default: 'all' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_supply_chain',
    description: 'Supply chain health: OpenSSF Scorecard scores, maintainer count, abandoned package detection for project dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'string', description: 'Minimum risk level: critical, high, medium', enum: ['critical', 'high', 'medium'] },
        refresh: { type: 'boolean', description: 'Re-fetch from APIs', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_dep_confusion',
    description: 'Detect dependency confusion vulnerabilities: internal package names that exist in public registries (typosquatting/supply chain attack vectors).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_remediation',
    description: 'Remediation SLA tracking: which vulnerabilities are overdue for fixing based on severity thresholds (critical=7d, high=30d, medium=90d).',
    inputSchema: {
      type: 'object',
      properties: {
        overdueOnly: { type: 'boolean', description: 'Show only overdue items', default: false },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  // ── Pattern tools (require enablePatterns=true) ─────────────────────────────
  {
    name: 'kirograph_pattern_coverage',
    description: 'OWASP Top 10 coverage report: shows which vulnerability categories are covered by bundled pattern rules and how many matches exist in each.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_pattern_save_baseline',
    description: 'Save current pattern match counts as a baseline for future diffing.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Baseline label (default: "default")', default: 'default' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
      },
    },
  },
  {
    name: 'kirograph_pattern_diff',
    description: 'Diff current pattern matches against a saved baseline. Shows new findings, resolved findings, and unchanged counts.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Baseline label (default: "default")', default: 'default' },
        projectPath: { type: 'string', description: 'Project root path (optional)' },
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
      projectPath: { type: 'string', description: 'Project root path (optional)' },
    },
  },
};

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

        // Security integration: surface vulnerability warnings if enableSecurity is true
        try {
          const projectRootSec = cg.getProjectRoot();
          const configSec = await (await import('../config')).loadConfig(projectRootSec);
          if (configSec.enableSecurity) {
            const dbSec = cg.getDatabase();
            dbSec.applySecuritySchema();
            const rawDbSec = dbSec.getRawDb();

            // Collect node IDs from entry points and related nodes
            const contextNodeIds = [
              ...ctx.entryPoints.map((n: any) => n.id),
              ...ctx.relatedNodes.map((n: any) => n.id),
            ].filter(Boolean);

            if (contextNodeIds.length > 0) {
              const { getSecurityWarningsForNodes, formatSecurityWarnings } = await import('../security/context-warnings');
              const warnings = getSecurityWarningsForNodes(rawDbSec, contextNodeIds);

              if (warnings.length > 0) {
                // Build a name map for entry points
                const nodeNames = new Map<string, string>();
                for (const n of ctx.entryPoints) {
                  nodeNames.set(n.id, n.name);
                }
                for (const n of ctx.relatedNodes) {
                  nodeNames.set(n.id, n.name);
                }

                const secSection = formatSecurityWarnings(warnings, nodeNames);
                if (secSection) {
                  lines.push(secSection);
                }
              }
            }
          }
        } catch { /* security is non-critical */ }

        // Pattern matches warning (when enablePatterns: true and pattern_matches table exists)
        try {
          const projectRootPat = cg.getProjectRoot();
          const configPat = await (await import('../config')).loadConfig(projectRootPat);
          if ((configPat as any).enablePatterns) {
            const dbPat = cg.getDatabase();
            dbPat.applyPatternsSchema();
            const rawDbPat = dbPat.getRawDb();
            const tableExists = rawDbPat.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
            if (tableExists) {
              // Collect file paths from context nodes
              const contextFiles = [
                ...ctx.entryPoints.map((n: any) => n.filePath),
                ...ctx.relatedNodes.map((n: any) => n.filePath),
              ].filter(Boolean) as string[];
              const uniqueContextFiles = [...new Set(contextFiles)];

              if (uniqueContextFiles.length > 0) {
                const placeholders = uniqueContextFiles.map(() => '?').join(',');
                const patternRows: Array<{ file_path: string; pattern_id: string; severity: string; owasp_category: string; line: number }> =
                  rawDbPat.all(
                    `SELECT file_path, pattern_id, severity, owasp_category, line FROM pattern_matches WHERE file_path IN (${placeholders}) ORDER BY severity DESC LIMIT 5`,
                    uniqueContextFiles
                  );
                if (patternRows.length > 0) {
                  const patternWarnings = patternRows.map(p =>
                    `- **${p.pattern_id}** [${p.severity.toUpperCase()}/${p.owasp_category}]: ${p.file_path}:${p.line}`
                  ).join('\n');
                  lines.push('', '## ⚠ Pattern Findings', '', patternWarnings);
                  if (patternRows.length === 5) lines.push('', 'More findings — run `kirograph pattern --list` to see all rules.');
                }
              }
            }
          }
        } catch { /* non-critical */ }

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

        // Check if symbol has pattern matches
        try {
          const rawDbImp = cg.getDatabase().getRawDb();
          const tableExistsImp = rawDbImp.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExistsImp) {
            const symNode = rawDbImp.get('SELECT id FROM nodes WHERE name = ? LIMIT 1', [args.symbol]);
            if (symNode) {
              const patternMatches = rawDbImp.all(
                'SELECT pattern_id, severity, line FROM pattern_matches WHERE symbol_node_id = ?',
                [(symNode as { id: string }).id]
              ) as Array<{ pattern_id: string; severity: string; line: number }>;
              if (patternMatches.length > 0) {
                output += '\n\n⚠ This symbol has pattern matches:';
                for (const pm of patternMatches) {
                  output += `\n  [${pm.severity.toUpperCase()}] ${pm.pattern_id} at line ${pm.line}`;
                }
              }
            }
          }
        } catch { /* non-critical */ }

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
                stats.semanticEngine === 'turboquant' ? `turboquant (${stats.vecIndexCount} entries · ANN)` :
                stats.semanticEngine === 'turbovec'   ? `turbovec (${stats.vecIndexCount} entries · ${stats.turbovecBits ?? 4} bits · Rust/SIMD)` :
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

        // Security stats
        let securityLine = '  Security: disabled';
        try {
          const { loadConfig: loadCfgSec } = await import('../config');
          const cfgSec = await loadCfgSec(cg.getProjectRoot());
          if (cfgSec.enableSecurity) {
            const db = cg.getDatabase();
            db.applySecuritySchema();
            const rawDb = db.getRawDb();
            const depCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies')?.cnt ?? 0;
            const vulnCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_vulnerabilities')?.cnt ?? 0;
            const affectedCount = rawDb.get("SELECT COUNT(*) as cnt FROM sec_reachability WHERE verdict = 'affected'")?.cnt ?? 0;
            const staleCount = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies WHERE vuln_data_stale = 1')?.cnt ?? 0;
            const staleNote = staleCount > 0 ? ` ⚠ ${staleCount} stale` : '';
            securityLine = `  Security: enabled — ${depCount} deps, ${vulnCount} vulns (${affectedCount} affected)${staleNote}`;
          }
        } catch { /* non-critical */ }

        // Patterns stats
        let patternsLine = '  Patterns: disabled';
        try {
          const { loadConfig: loadCfgPat } = await import('../config');
          const cfgP = await loadCfgPat(cg.getProjectRoot());
          if ((cfgP as any).enablePatterns) {
            const rawDbP = cg.getDatabase().getRawDb();
            const tableExistsP = rawDbP.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
            if (tableExistsP) {
              const matchCount = rawDbP.get('SELECT COUNT(*) as cnt FROM pattern_matches')?.cnt ?? 0;
              const fileCount = rawDbP.get('SELECT COUNT(DISTINCT file_path) as cnt FROM pattern_matches')?.cnt ?? 0;
              const ruleCount = rawDbP.get('SELECT COUNT(DISTINCT pattern_id) as cnt FROM pattern_matches')?.cnt ?? 0;
              patternsLine = `  Patterns: enabled — ${matchCount} matches, ${ruleCount} rules triggered, ${fileCount} files`;
            } else {
              patternsLine = `  Patterns: enabled (no data yet — run kirograph index)`;
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
          securityLine,
          patternsLine,
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
          const lines = [`${i + 1}. [${r.observation.kind}] ${r.observation.content} (${age})`];
          if (r.relations && r.relations.length > 0) {
            for (const rel of r.relations) {
              const other = rel.observationA === r.observation.id ? rel.observationB : rel.observationA;
              const icon = rel.relation === 'conflicts_with' ? '⚡' : rel.relation === 'supersedes' ? '↩' : '~';
              lines.push(`  ${icon} ${rel.relation} ${other} (confidence: ${rel.confidence})${rel.judgmentStatus === 'judged' ? ' (judged)' : ''}`);
            }
          }
          return lines.join('\n');
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
          topicKey: args.topicKey as string | undefined,
          reviewAfter: args.reviewAfter as number | undefined,
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
          `  Relations: ${stats.relations} (${stats.pendingConflicts} pending)`,
          `  Caveman compression: ${config.cavemanMode !== 'off' ? config.cavemanMode : 'off (storing raw)'}`,
        ];
        return lines.join('\n');
      }

      case 'kirograph_mem_review': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const obs = mem.getObservationsForReview(args.limit as number ?? 20);
        if (obs.length === 0) return 'No overdue observations — all review_after dates are in the future.';
        const now = Date.now();
        return obs.map((o, i) => {
          const daysOverdue = Math.floor((now - (o.reviewAfter ?? now)) / 86400000);
          return `${i + 1}. [${o.kind}]${o.topicKey ? ` (${o.topicKey})` : ''} ${o.content.slice(0, 120)} — overdue by ${daysOverdue}d`;
        }).join('\n');
      }

      case 'kirograph_mem_mark_reviewed': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        mem.markReviewed(args.id as string);
        return `Observation ${args.id} marked as reviewed.`;
      }

      case 'kirograph_mem_compare': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const relationId = mem.compareObservations({
          observationA: args.observationA as string,
          observationB: args.observationB as string,
          relation: args.relation as any,
          confidence: args.confidence as number ?? 1.0,
          reason: args.reason as string | undefined,
          evidence: args.evidence as string | undefined,
        });
        return `Relation ${relationId} created (${args.relation}, confidence: ${args.confidence ?? 1.0}). Use kirograph_mem_judge to finalize.`;
      }

      case 'kirograph_mem_judge': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        mem.judgeRelation(
          args.relationId as string,
          args.relation as any,
          args.confidence as number,
          args.reason as string | undefined,
          args.evidence as string | undefined,
        );
        return `Relation ${args.relationId} judged as [${args.relation}] (confidence: ${args.confidence}).`;
      }

      case 'kirograph_mem_capture': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const extracted = mem.capturePassive(args.content as string);
        if (extracted.length === 0) return 'No structured sections found. Use ## Key Learnings, ## Observations, ## Decisions, or ## Key Changes headings.';
        return `Captured ${extracted.length} observation(s):\n` + extracted.map((e, i) => `${i + 1}. [${e.kind}] ${e.content.slice(0, 100)}${e.id ? '' : ' (duplicate)'}`).join('\n');
      }

      case 'kirograph_mem_save_prompt': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const id = await mem.savePrompt(args.content as string);
        return `Prompt saved as ${id}.`;
      }

      case 'kirograph_mem_suggest_topic_key': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const key = mem.suggestTopicKey(args.kind as string, args.title as string);
        return `Suggested topic_key: ${key}`;
      }

      case 'kirograph_mem_conflicts_scan': {
        const { loadConfig } = await import('../config');
        const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableMemory) return 'Memory is not enabled.';
        const { MemoryManager } = await import('../memory/index');
        const db = cg.getDatabase(); db.applyMemorySchema();
        const mem = new MemoryManager(config, db.getRawDb());
        mem.initialize();
        const candidates = mem.scanConflicts(args.limit as number ?? 50);
        if (candidates.length === 0) return 'No potential conflicts found among recent observations.';
        return `Found ${candidates.length} potential conflict(s):\n` + candidates.map((c, i) =>
          `${i + 1}. [${c.observationA.kind}] "${c.observationA.content.slice(0, 80)}" ↔ [${c.observationB.kind}] "${c.observationB.content.slice(0, 80)}" (similarity: ${c.similarity.toFixed(2)})`
        ).join('\n') + '\n\nUse kirograph_mem_compare to establish relations.';
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

      // ── Security tools (require enableSecurity=true) ──────────────────────────

      case 'kirograph_security': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';
        if (!config.enableArchitecture) return 'Security requires architecture analysis. Set enableArchitecture: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        const depCount: { count: number } = rawDb.get(
          `SELECT COUNT(*) as count FROM sec_dependencies`,
        ) ?? { count: 0 };

        const vulnCount: { count: number } = rawDb.get(
          `SELECT COUNT(*) as count FROM sec_vulnerabilities`,
        ) ?? { count: 0 };

        const verdictRows: Array<{ verdict: string; count: number }> = rawDb.all(
          `SELECT verdict, COUNT(*) as count FROM sec_reachability GROUP BY verdict`,
        );
        const verdicts: Record<string, number> = {};
        for (const row of verdictRows) {
          verdicts[row.verdict] = row.count;
        }

        const staleCount: { count: number } = rawDb.get(
          `SELECT COUNT(*) as count FROM sec_dependencies WHERE vuln_data_stale = 1`,
        ) ?? { count: 0 };

        // Count suppressed CVEs
        const { SuppressionManager: SecSuppressionManager } = await import('../security/suppressions');
        const secSuppressions = new SecSuppressionManager(projectRoot);
        const allCveIds: Array<{ cve_id: string }> = rawDb.all(`SELECT cve_id FROM sec_vulnerabilities`);
        const suppressedCveCount = allCveIds.filter(r => secSuppressions.isSuppressed(r.cve_id)).length;
        const visibleVulnCount = vulnCount.count - suppressedCveCount;

        const lines: string[] = [
          '# Security Overview',
          '',
          `Dependencies: ${depCount.count}`,
          `Vulnerabilities: ${visibleVulnCount}${suppressedCveCount > 0 ? ` (${suppressedCveCount} suppressed)` : ''}`,
        ];

        if (visibleVulnCount > 0) {
          const affected = verdicts['affected'] ?? 0;
          const notAffected = verdicts['not_affected'] ?? 0;
          const underInvestigation = verdicts['under_investigation'] ?? 0;
          const pending = visibleVulnCount - affected - notAffected - underInvestigation;

          lines.push('', '## Reachability Verdicts', '');
          if (affected > 0) lines.push(`● Affected: ${affected}`);
          if (notAffected > 0) lines.push(`● Not affected: ${notAffected}`);
          if (underInvestigation > 0) lines.push(`● Under investigation: ${underInvestigation}`);
          if (pending > 0) lines.push(`● Pending analysis: ${pending}`);
        }

        if (staleCount.count > 0) {
          lines.push('', `⚠ ${staleCount.count} dependenc${staleCount.count === 1 ? 'y has' : 'ies have'} stale vulnerability data. Use kirograph_vulns with refresh=true to update.`);
        }

        // Check if vulnerability data is stale by age
        const lastVulnCheck = (rawDb.get(
          `SELECT MIN(last_vuln_check) as oldest FROM sec_dependencies WHERE last_vuln_check IS NOT NULL`,
        ) as { oldest: number | null } | undefined)?.oldest;
        if (lastVulnCheck != null) {
          const ageMs = Date.now() - lastVulnCheck;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const maxAge = config.securityEnrichMaxAgeDays ?? 7;
          if (ageDays > maxAge) {
            lines.push('', `⚠ Vulnerability data is ${Math.floor(ageDays)} days old (max: ${maxAge}). Run kirograph vulns --refresh to update.`);
          }
        }

        // Pattern SAST findings count
        try {
          const rawDbSec = db.getRawDb();
          const tableExistsSec = rawDbSec.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExistsSec) {
            const patternCount = rawDbSec.get('SELECT COUNT(*) as cnt FROM pattern_matches')?.cnt ?? 0;
            if (patternCount > 0) {
              const critCount = rawDbSec.get("SELECT COUNT(*) as cnt FROM pattern_matches WHERE severity = 'critical'")?.cnt ?? 0;
              lines.push(`SAST findings: ${patternCount} pattern matches (${critCount} critical)`);
            }
          }
        } catch { /* non-critical */ }

        return lines.join('\n');
      }

      case 'kirograph_vulns': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        // Handle refresh
        if (args.refresh === true) {
          const { OsvAdapter } = await import('../security/vuln/osv-adapter');
          const { VulnerabilityDatabaseClient } = await import('../security/vuln/client');

          const adapters = config.securityDatabases.map((dbName: string) => {
            if (dbName.toUpperCase() === 'OSV') return new OsvAdapter();
            return null;
          }).filter(Boolean) as any[];

          const client = new VulnerabilityDatabaseClient(adapters, db);
          await client.enrichAll();
        }

        // Build query
        let query = `
          SELECT
            v.node_id, v.cve_id, v.severity_score, v.fixed_version, v.summary,
            v.epss_score, v.epss_percentile, v.risk_score,
            d.package_name, d.ecosystem, d.resolved_version, d.declared_constraint,
            r.verdict
          FROM sec_vulnerabilities v
          LEFT JOIN edges e ON e.target = v.node_id AND e.kind = 'has_vulnerability'
          LEFT JOIN sec_dependencies d ON d.node_id = e.source
          LEFT JOIN sec_reachability r ON r.vulnerability_node_id = v.node_id
          WHERE 1=1
        `;
        const params: any[] = [];

        // Severity filter
        if (args.severity) {
          const severityRanges: Record<string, [number, number]> = {
            critical: [9.0, 10.0],
            high: [7.0, 8.9],
            medium: [4.0, 6.9],
            low: [0.1, 3.9],
          };
          const range = severityRanges[(args.severity as string).toLowerCase()];
          if (!range) return `Invalid severity: ${args.severity}. Use: critical, high, medium, low`;
          query += ` AND v.severity_score >= ? AND v.severity_score <= ?`;
          params.push(range[0], range[1]);
        }

        // Verdict filter
        if (args.verdict) {
          const validVerdicts = ['affected', 'not_affected', 'under_investigation'];
          if (!validVerdicts.includes(args.verdict as string)) {
            return `Invalid verdict: ${args.verdict}. Use: affected, not_affected, under_investigation`;
          }
          query += ` AND r.verdict = ?`;
          params.push(args.verdict);
        }

        const limit = clampLimit(args.limit as number | undefined, 20);
        query += ` ORDER BY v.risk_score DESC NULLS LAST LIMIT ?`;
        params.push(limit);

        const rows: Array<{
          node_id: string;
          cve_id: string;
          severity_score: number | null;
          fixed_version: string | null;
          summary: string | null;
          epss_score: number | null;
          epss_percentile: number | null;
          risk_score: number | null;
          package_name: string | null;
          ecosystem: string | null;
          resolved_version: string | null;
          declared_constraint: string | null;
          verdict: string | null;
        }> = rawDb.all(query, params);

        // Deduplicate by (cve_id, package_name, ecosystem) — same CVE can appear multiple
        // times when a package is declared in multiple manifests (monorepo).
        const verdictRankMcp = (v: string | null) =>
          v === 'affected' ? 3 : v === 'under_investigation' ? 2 : v === 'not_affected' ? 1 : 0;
        const dedupMapMcp = new Map<string, typeof rows[0]>();
        for (const row of rows) {
          const key = `${row.cve_id}::${row.package_name ?? ''}::${row.ecosystem ?? ''}`;
          const ex = dedupMapMcp.get(key);
          if (!ex || verdictRankMcp(row.verdict) > verdictRankMcp(ex.verdict)) dedupMapMcp.set(key, row);
        }
        const dedupedRowsMcp = [...dedupMapMcp.values()];

        // Filter out suppressed CVEs
        const { SuppressionManager } = await import('../security/suppressions');
        const suppressionMgr = new SuppressionManager(projectRoot);
        const suppressedCount = dedupedRowsMcp.filter(row => suppressionMgr.isSuppressed(row.cve_id)).length;
        const filteredRows = dedupedRowsMcp.filter(row => !suppressionMgr.isSuppressed(row.cve_id));

        if (filteredRows.length === 0) {
          const noMatch = 'No vulnerabilities found' + ((args.severity || args.verdict) ? ' matching filters.' : '.');
          return suppressedCount > 0 ? `${noMatch} (${suppressedCount} suppressed)` : noMatch;
        }

        const { formatFixSuggestion } = await import('../security/export/fix-suggestions');

        const lines: string[] = [`Vulnerabilities (${filteredRows.length}${suppressedCount > 0 ? `, ${suppressedCount} suppressed` : ''}):\n`];

        for (const row of filteredRows) {
          const score = row.severity_score;
          let severityLabel: string;
          if (score == null) severityLabel = 'UNKNOWN';
          else if (score >= 9.0) severityLabel = 'CRITICAL';
          else if (score >= 7.0) severityLabel = 'HIGH';
          else if (score >= 4.0) severityLabel = 'MEDIUM';
          else severityLabel = 'LOW';

          let verdictLabel: string;
          if (!row.verdict) verdictLabel = 'pending';
          else if (row.verdict === 'affected') verdictLabel = 'affected';
          else if (row.verdict === 'not_affected') verdictLabel = 'not affected';
          else verdictLabel = 'investigating';

          const pkg = row.package_name
            ? `${row.package_name}@${row.resolved_version || row.declared_constraint || '?'}`
            : 'unknown package';

          const epssNote = row.epss_score != null
            ? ` [EPSS: ${row.epss_score.toFixed(2)}]`
            : '';
          const riskNote = row.risk_score != null
            ? ` [Risk: ${row.risk_score.toFixed(1)}]`
            : '';
          lines.push(`${severityLabel}  ${row.cve_id}  ${pkg}  [${verdictLabel}]${epssNote}${riskNote}`);

          if (row.summary && row.summary !== 'Manually registered') {
            const truncSummary = row.summary.length > 120 ? row.summary.slice(0, 120) + '…' : row.summary;
            lines.push(`  ${truncSummary}`);
          }

          if (row.fixed_version && row.ecosystem && row.package_name) {
            const fix = formatFixSuggestion(row.ecosystem, row.package_name, row.fixed_version);
            if (fix) lines.push(`  ${fix}`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_vuln_add': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const cveId = args.cveId as string;
        const pkgName = args.package as string;
        if (!cveId) return 'Error: cveId is required.';
        if (!pkgName) return 'Error: package is required.';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        // Find matching Dependency_Node
        const depRow: { node_id: string; ecosystem: string } | undefined = rawDb.get(
          `SELECT node_id, ecosystem FROM sec_dependencies WHERE package_name = ?`,
          [pkgName],
        );

        if (!depRow) {
          return `No dependency found matching "${pkgName}". Run kirograph index first to discover dependencies.`;
        }

        // Create Vulnerability_Node
        const vulnNodeId = `vuln:${cveId}`;
        const now = Date.now();
        const severity = args.severity as number | undefined;
        const summary = (args.summary as string) ?? 'Manually registered';
        const fixedVersion = (args.fixedVersion as string) ?? null;

        rawDb.run(
          `INSERT OR REPLACE INTO nodes
            (id, kind, name, qualified_name, file_path, language,
             start_line, end_line, start_column, end_column,
             is_exported, is_async, is_static, is_abstract, updated_at)
           VALUES (?, 'vulnerability', ?, ?, '', 'unknown', 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
          [vulnNodeId, cveId, cveId, now],
        );

        rawDb.run(
          `INSERT OR REPLACE INTO sec_vulnerabilities
            (node_id, cve_id, severity_score, affected_ranges, fixed_version, summary, source_database)
           VALUES (?, ?, ?, '[]', ?, ?, 'manual')`,
          [vulnNodeId, cveId, severity ?? null, fixedVersion, summary],
        );

        // Create has_vulnerability edge
        rawDb.run(
          `INSERT OR IGNORE INTO edges (source, target, kind, confidence, confidence_score)
           VALUES (?, ?, 'has_vulnerability', 'extracted', 1.0)`,
          [depRow.node_id, vulnNodeId],
        );

        return `Registered ${cveId} against ${pkgName}.`;
      }

      case 'kirograph_vuln_suppress': {
        const projectRoot = cg.getProjectRoot();
        const cveId = args.cveId as string;
        if (!cveId) return 'Error: cveId is required.';

        const { SuppressionManager } = await import('../security/suppressions');
        const manager = new SuppressionManager(projectRoot);
        manager.add(cveId, args.reason as string | undefined, args.expires as string | undefined);

        const reasonNote = args.reason ? ` Reason: ${args.reason}.` : '';
        const expiresNote = args.expires ? ` Expires: ${args.expires}.` : '';
        return `${cveId} suppressed.${reasonNote}${expiresNote}`;
      }

      case 'kirograph_sbom': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { SBOMExporter } = await import('../security/export/sbom');
        const exporter = new SBOMExporter(db, projectRoot);
        const json = exporter.exportJSON();

        return truncate(json);
      }

      case 'kirograph_vex': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { VEXExporter } = await import('../security/export/vex');
        const exporter = new VEXExporter(db, projectRoot);
        const json = exporter.exportJSON();

        return truncate(json);
      }

      case 'kirograph_reachability': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const target = args.target as string;
        if (!target) return 'Error: target is required (dependency name or CVE ID).';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        // Try to find target as a CVE ID in sec_vulnerabilities
        let vulnerabilityNodeId: string | null = null;
        let targetLabel = target;

        const vulnRow: { node_id: string } | undefined = rawDb.get(
          `SELECT node_id FROM sec_vulnerabilities WHERE cve_id = ?`,
          [target],
        );

        if (vulnRow) {
          vulnerabilityNodeId = vulnRow.node_id;
        } else {
          // Try to find target as a dependency name
          const depRow: { node_id: string; package_name: string } | undefined = rawDb.get(
            `SELECT node_id, package_name FROM sec_dependencies WHERE package_name = ?`,
            [target],
          );

          if (depRow) {
            targetLabel = depRow.package_name;
            // Find vulnerabilities linked to this dependency
            const vulnEdge: { target: string } | undefined = rawDb.get(
              `SELECT target FROM edges WHERE source = ? AND kind = 'has_vulnerability' LIMIT 1`,
              [depRow.node_id],
            );

            if (vulnEdge) {
              vulnerabilityNodeId = vulnEdge.target;
            } else {
              return `No vulnerabilities found for dependency "${target}". The dependency exists but has no known vulnerabilities.`;
            }
          } else {
            return `Target "${target}" not found. Provide a valid CVE ID or dependency package name.`;
          }
        }

        // Run reachability analysis
        const { ReachabilityAnalyzer } = await import('../security/reachability');
        const analyzer = new ReachabilityAnalyzer(db, config);
        const result = await analyzer.analyze(vulnerabilityNodeId);

        const lines: string[] = [
          `# Reachability: ${targetLabel}`,
          '',
          `Verdict: ${result.verdict}`,
          `Reaching entry points: ${result.reachingEntryPointCount}`,
        ];

        if (result.paths.length > 0) {
          lines.push('', '## Paths');
          for (const p of result.paths.slice(0, 5)) {
            lines.push(`- From ${p.entryPoint}: ${p.path.join(' → ')}`);
          }
          if (result.paths.length > 5) {
            lines.push(`  …and ${result.paths.length - 5} more paths`);
          }
        }

        if (result.unresolvedSymbols.length > 0) {
          lines.push('', '## Unresolved Symbols');
          for (const sym of result.unresolvedSymbols.slice(0, 10)) {
            lines.push(`- ${sym}`);
          }
          if (result.unresolvedSymbols.length > 10) {
            lines.push(`  …and ${result.unresolvedSymbols.length - 10} more`);
          }
        }

        // Get impact summary if affected
        if (result.verdict === 'affected') {
          const impact = await analyzer.getImpactSummary(vulnerabilityNodeId);
          if (impact) {
            lines.push('', '## Impact Summary');
            if (impact.affectedLayers.length > 0) {
              lines.push(`Affected layers: ${impact.affectedLayers.join(', ')}`);
            }
            lines.push(`Affected entry points: ${impact.affectedEntryPoints.length}`);
            lines.push(`Distinct paths: ${impact.distinctPathCount}`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_staleness': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        const threshold = typeof args.threshold === 'number' ? args.threshold : 0.3;

        // Optionally refresh staleness data from registries
        if (args.refresh === true) {
          const { StalenessChecker } = await import('../security/staleness');
          const checker = new StalenessChecker(db);
          await checker.checkAll();
        }

        const rows: Array<{
          package_name: string;
          ecosystem: string;
          resolved_version: string | null;
          declared_constraint: string;
          latest_version: string | null;
          latest_published: number | null;
          staleness_score: number | null;
        }> = rawDb.all(
          `SELECT package_name, ecosystem, resolved_version, declared_constraint,
                  latest_version, latest_published, staleness_score
           FROM sec_dependencies
           WHERE staleness_score >= ?
           ORDER BY staleness_score DESC`,
          [threshold],
        );

        if (rows.length === 0) {
          return `No dependencies found with staleness_score >= ${threshold}.` +
            (args.refresh ? '' : ' Use refresh=true to fetch latest version data from registries.');
        }

        const lines: string[] = [`Stale Dependencies (threshold: ${threshold}):\n`];
        for (const row of rows) {
          const resolved = row.resolved_version ?? row.declared_constraint ?? '?';
          const latest = row.latest_version ?? '?';
          const score = row.staleness_score ?? 0;
          const months = row.latest_published
            ? Math.round((Date.now() - row.latest_published) / (1000 * 60 * 60 * 24 * 30))
            : null;
          const bar = '█'.repeat(Math.round(score * 10)) + '░'.repeat(10 - Math.round(score * 10));
          const monthsStr = months !== null ? `, ${months}mo since latest` : '';
          lines.push(`${row.package_name} (${row.ecosystem}): ${resolved} → ${latest}${monthsStr}`);
          lines.push(`  ${bar} ${score.toFixed(2)}`);
        }

        const totalCount: { count: number } = rawDb.get(`SELECT COUNT(*) as count FROM sec_dependencies`) ?? { count: 0 };
        lines.push('', `${rows.length} of ${totalCount.count} dependencies are stale (score >= ${threshold})`);

        return truncate(lines.join('\n'));
      }

      case 'kirograph_licenses': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();
        const rawDb = db.getRawDb();

        const deps: Array<{
          package_name: string;
          ecosystem: string;
          license: string | null;
        }> = rawDb.all(
          `SELECT package_name, ecosystem, license FROM sec_dependencies ORDER BY ecosystem, package_name`,
        );

        const { checkLicensePolicy } = await import('../security/license');
        const policy = config.securityLicensePolicy;
        const violations = checkLicensePolicy(deps, policy);

        if (args.policy === true) {
          // Return only violations
          if (violations.length === 0) {
            return 'No license policy violations found.';
          }
          const lines: string[] = ['# License Policy Violations\n'];
          for (const v of violations) {
            lines.push(`${v.severity.toUpperCase()}  ${v.packageName} [${v.ecosystem}]  ${v.license}`);
          }
          const denyCount = violations.filter(v => v.severity === 'deny').length;
          const warnCount = violations.filter(v => v.severity === 'warn').length;
          lines.push('');
          if (denyCount > 0) lines.push(`${denyCount} denied license${denyCount !== 1 ? 's' : ''}`);
          if (warnCount > 0) lines.push(`${warnCount} license warning${warnCount !== 1 ? 's' : ''}`);
          return truncate(lines.join('\n'));
        }

        // Full listing
        if (deps.length === 0) {
          return 'No dependencies found. Run kirograph index first.';
        }

        const violationMap = new Map<string, 'deny' | 'warn'>();
        for (const v of violations) {
          violationMap.set(`${v.ecosystem}:${v.packageName}`, v.severity);
        }

        const lines: string[] = [`# License Report (${deps.length} dependencies)\n`];

        // Violations first
        if (violations.length > 0) {
          lines.push('## Policy Violations\n');
          for (const v of violations) {
            lines.push(`${v.severity.toUpperCase()}  ${v.packageName} [${v.ecosystem}]  ${v.license}`);
          }
          lines.push('');
        }

        lines.push('## All Dependencies\n');
        lines.push('package | ecosystem | license | status');
        lines.push('------- | --------- | ------- | ------');

        for (const dep of deps) {
          const key = `${dep.ecosystem}:${dep.package_name}`;
          const violation = violationMap.get(key);
          const license = dep.license ?? '(unknown)';
          const status = violation ?? (dep.license ? 'ok' : 'unknown');
          lines.push(`${dep.package_name} | ${dep.ecosystem} | ${license} | ${status}`);
        }

        const denyCount = violations.filter(v => v.severity === 'deny').length;
        const warnCount = violations.filter(v => v.severity === 'warn').length;
        const unknownCount = deps.filter(d => !d.license).length;

        lines.push('');
        if (denyCount > 0) lines.push(`${denyCount} denied license${denyCount !== 1 ? 's' : ''}`);
        if (warnCount > 0) lines.push(`${warnCount} license warning${warnCount !== 1 ? 's' : ''}`);
        if (unknownCount > 0) lines.push(`${unknownCount} unknown license${unknownCount !== 1 ? 's' : ''}`);
        if (denyCount === 0 && warnCount === 0) lines.push('No policy violations');

        return truncate(lines.join('\n'));
      }

      case 'kirograph_attack_surface': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { AttackSurfaceAnalyzer } = await import('../security/attack-surface');
        const analyzer = new AttackSurfaceAnalyzer(db);
        const result = await analyzer.analyze();

        if (result.totalRoutes === 0) {
          return 'No route nodes found in the graph. Ensure the project has been indexed with architecture analysis enabled.';
        }

        const limit = clampLimit(args.limit as number | undefined, 20);
        const routes = (args.publicOnly === true)
          ? result.criticalPaths.filter(r => r.exposureLevel === 'public')
          : result.criticalPaths;

        const lines: string[] = [
          '# Attack Surface',
          '',
          `Total routes: ${result.totalRoutes}  Public: ${result.publicRoutes}  Authenticated: ${result.authenticatedRoutes}  Routes with vulns: ${result.routesWithVulns}`,
          '',
        ];

        const displayed = routes.slice(0, limit);
        if (displayed.length === 0) {
          lines.push(args.publicOnly === true
            ? 'No public routes with vulnerable dependencies found.'
            : 'No routes with vulnerable dependencies found.');
        } else {
          for (const entry of displayed) {
            const authTag = entry.isAuthenticated ? '[auth]' : '[public]';
            const riskTag = entry.riskScore > 0 ? ` risk=${entry.riskScore.toFixed(1)}` : '';
            lines.push(`${authTag} ${entry.route} (${entry.exposureLevel})${riskTag}  ${entry.filePath}`);
            for (const dep of entry.vulnerableDeps.slice(0, 3)) {
              lines.push(`  └ ${dep.cveId} via ${dep.packageName} (${dep.hopCount} hop${dep.hopCount !== 1 ? 's' : ''}${dep.verdict ? `, ${dep.verdict}` : ''})`);
            }
            if (entry.vulnerableDeps.length > 3) {
              lines.push(`  └ …and ${entry.vulnerableDeps.length - 3} more vulns`);
            }
          }
          if (routes.length > limit) {
            lines.push('', `…and ${routes.length - limit} more routes (increase limit to see all)`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_secrets': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { SecretsScanner } = await import('../security/secrets');
        const scanner = new SecretsScanner(db, projectRoot);
        const result = await scanner.scan({ includeTests: args.includeTests === true });

        if (result.totalFindings === 0) {
          return `No secrets found. Scanned ${result.filesScanned} file${result.filesScanned !== 1 ? 's' : ''}.`;
        }

        let findings = result.findings;
        if (args.severity) {
          findings = findings.filter(f => f.severity === (args.severity as string));
        }

        if (findings.length === 0) {
          return `No secrets found matching severity "${args.severity}". Total findings (all severities): ${result.totalFindings}.`;
        }

        const lines: string[] = [
          `# Secrets Scan (${result.filesScanned} files scanned)`,
          '',
          `Found: ${result.totalFindings}  Critical: ${result.criticalCount}  High: ${result.highCount}`,
          '',
        ];

        for (const f of findings) {
          lines.push(`${f.severity.toUpperCase()}  ${f.type}`);
          lines.push(`  ${f.filePath}:${f.line}:${f.column}  snippet: ${f.snippet}`);
          if (f.nodeName) {
            lines.push(`  in function: ${f.nodeName}`);
          }
          if (f.entryPointCount > 0) {
            lines.push(`  reachable from ${f.entryPointCount} entry point${f.entryPointCount !== 1 ? 's' : ''}`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_security_flows': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { DataFlowAnalyzer } = await import('../security/data-flows');
        const analyzer = new DataFlowAnalyzer(db);
        let findings = await analyzer.analyze();

        const typeFilter = (args.type as string | undefined) ?? 'all';
        const TYPE_MAP: Record<string, string> = {
          sql: 'sql-injection',
          eval: 'dangerous-eval',
          deserialize: 'unsafe-deserialize',
          path: 'path-traversal',
          crypto: 'hardcoded-crypto',
        };

        if (typeFilter !== 'all') {
          const mapped = TYPE_MAP[typeFilter];
          if (!mapped) return `Invalid type filter "${typeFilter}". Use: sql, eval, deserialize, path, crypto, all`;
          findings = findings.filter(f => f.type === mapped);
        }

        if (findings.length === 0) {
          return typeFilter === 'all'
            ? 'No dangerous data flows detected.'
            : `No "${typeFilter}" findings detected.`;
        }

        const lines: string[] = [
          `# Security Flows (${findings.length} finding${findings.length !== 1 ? 's' : ''})`,
          '',
        ];

        for (const f of findings) {
          lines.push(`${f.severity.toUpperCase()}  [${f.owaspCategory}]  ${f.type}`);
          lines.push(`  ${f.filePath}:${f.line}  symbol: ${f.symbol}`);
          lines.push(`  ${f.description}`);
          lines.push(`  Fix: ${f.recommendation}`);
          lines.push('');
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_supply_chain': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { SupplyChainChecker } = await import('../security/supply-chain');
        const checker = new SupplyChainChecker(db);
        const { results, errors } = await checker.checkAll();

        const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
        const thresholdArg = args.threshold as string | undefined;
        const thresholdOrder = thresholdArg ? (RISK_ORDER[thresholdArg] ?? 4) : 2; // default: medium and above

        const filtered = results
          .filter(r => (RISK_ORDER[r.riskLevel] ?? 4) <= thresholdOrder)
          .sort((a, b) => (RISK_ORDER[a.riskLevel] ?? 4) - (RISK_ORDER[b.riskLevel] ?? 4));

        if (filtered.length === 0) {
          return `No supply chain risks found at threshold "${thresholdArg ?? 'medium'}" or above. Checked ${results.length} dependencies.`;
        }

        const lines: string[] = [
          `# Supply Chain Health (${filtered.length} risks, threshold: ${thresholdArg ?? 'medium'})`,
          '',
        ];

        for (const r of filtered) {
          const scoreStr = r.scorecardScore !== null ? ` scorecard=${r.scorecardScore.toFixed(1)}/10` : '';
          const maintainerStr = r.maintainerCount !== null ? ` maintainers=${r.maintainerCount}` : '';
          lines.push(`${r.riskLevel.toUpperCase()}  ${r.packageName} (${r.ecosystem})${scoreStr}${maintainerStr}`);
          for (const reason of r.riskReasons) {
            lines.push(`  • ${reason}`);
          }
        }

        if (errors.length > 0) {
          lines.push('', `⚠ ${errors.length} package${errors.length !== 1 ? 's' : ''} could not be checked (network errors)`);
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_dep_confusion': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { DepConfusionChecker } = await import('../security/dep-confusion');
        const checker = new DepConfusionChecker(db);
        const findings = await checker.check();

        if (findings.length === 0) {
          return 'No dependency confusion vulnerabilities detected.';
        }

        const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2 };
        const sorted = [...findings].sort((a, b) => (RISK_ORDER[a.riskLevel] ?? 3) - (RISK_ORDER[b.riskLevel] ?? 3));

        const lines: string[] = [
          `# Dependency Confusion (${findings.length} finding${findings.length !== 1 ? 's' : ''})`,
          '',
        ];

        for (const f of sorted) {
          lines.push(`${f.riskLevel.toUpperCase()}  ${f.packageName} (${f.ecosystem})`);
          lines.push(`  ${f.explanation}`);
          if (f.publicExists && f.publicVersion) {
            lines.push(`  Public version: ${f.publicVersion}${f.publicPublishedAt ? `  published: ${f.publicPublishedAt}` : ''}`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_remediation': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableSecurity) return 'Security analysis is not enabled. Set enableSecurity: true in .kirograph/config.json and run kirograph index.';

        const db = cg.getDatabase();
        db.applySecuritySchema();

        const { RemediationTracker } = await import('../security/remediation');
        const tracker = new RemediationTracker(db);
        let statuses = tracker.getStatus();

        if (args.overdueOnly === true) {
          statuses = statuses.filter(s => s.isOverdue);
        }

        if (statuses.length === 0) {
          return args.overdueOnly === true
            ? 'No overdue vulnerabilities found.'
            : 'No open vulnerabilities with SLA tracking data found.';
        }

        // Sort: overdue first, then by slaStatus, then by severity desc
        const SLA_ORDER: Record<string, number> = { overdue: 0, warning: 1, no_fix: 2, ok: 3 };
        statuses.sort((a, b) => {
          const slaA = SLA_ORDER[a.slaStatus] ?? 3;
          const slaB = SLA_ORDER[b.slaStatus] ?? 3;
          if (slaA !== slaB) return slaA - slaB;
          return (b.severity ?? 0) - (a.severity ?? 0);
        });

        const overdueCount = statuses.filter(s => s.isOverdue).length;
        const warningCount = statuses.filter(s => s.slaStatus === 'warning').length;

        const lines: string[] = [
          `# Remediation SLA (${statuses.length} open${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}${warningCount > 0 ? `, ${warningCount} warning` : ''})`,
          '',
        ];

        for (const s of statuses) {
          const severityLabel = s.severity == null ? 'UNKNOWN'
            : s.severity >= 9 ? 'CRITICAL'
            : s.severity >= 7 ? 'HIGH'
            : s.severity >= 4 ? 'MEDIUM'
            : 'LOW';

          const slaTag = s.slaStatus === 'overdue' ? '[OVERDUE]'
            : s.slaStatus === 'warning' ? '[WARNING]'
            : s.slaStatus === 'no_fix' ? '[NO_FIX]'
            : '[OK]';

          lines.push(`${slaTag}  ${severityLabel}  ${s.cveId}  ${s.packageName}`);
          if (s.daysOpen !== null) lines.push(`  Open for ${s.daysOpen} day${s.daysOpen !== 1 ? 's' : ''}`);
          if (s.daysWithFixAvailable !== null) lines.push(`  Fix available for ${s.daysWithFixAvailable} day${s.daysWithFixAvailable !== 1 ? 's' : ''}`);
          if (s.slaDeadline !== null) {
            const deadlineDate = new Date(s.slaDeadline).toISOString().slice(0, 10);
            lines.push(`  SLA deadline: ${deadlineDate}`);
          }
        }

        return truncate(lines.join('\n'));
      }

      case 'kirograph_live_search': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);

        if (!config.enablePatterns) {
          return 'kirograph_live_search requires enablePatterns: true in .kirograph/config.json';
        }

        const { PatternRunner } = await import('../patterns/runner');
        const runner = new PatternRunner();

        if (!runner.isAvailable()) {
          return 'kirograph_live_search requires @ast-grep/napi. Run: npm install @ast-grep/napi';
        }

        const pattern = args.pattern as string;
        const language = args.language as string;
        const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
        const limit = Math.max(1, Math.min(100, Math.round(rawLimit)));

        const db = cg.getDatabase();
        const rawDb = db.getRawDb();

        const files: Array<{ path: string }> = rawDb.all(
          'SELECT path FROM files WHERE language = ? LIMIT 5000',
          [language],
        );

        const results: Array<{ filePath: string; line: number; matchText: string }> = [];
        let truncated = false;

        for (const file of files) {
          if (results.length >= limit) { truncated = true; break; }

          let content: string;
          try {
            const fullPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);
            content = fs.readFileSync(fullPath, 'utf8');
          } catch {
            continue;
          }

          const matches = await runner.runInline(pattern, language, content);
          for (const m of matches) {
            if (results.length >= limit) { truncated = true; break; }
            results.push({ filePath: file.path, line: m.line, matchText: m.matchText });
          }
        }

        if (results.length === 0) {
          return `0 matches for '${pattern}' in ${language} files`;
        }

        const lines: string[] = [
          `${results.length} match${results.length !== 1 ? 'es' : ''} for '${pattern}' in ${language} files`,
          '',
        ];

        for (const r of results) {
          lines.push(` ${r.filePath}:${r.line}`);
          lines.push(`   ${r.matchText}`);
          lines.push('');
        }

        if (truncated) {
          lines.push(`[truncated — showing first ${limit} results; refine your pattern or use --lang to narrow scope]`);
        }

        return truncate(lines.join('\n'));
      }

      // ── Pattern tools ──────────────────────────────────────────────────────────

      case 'kirograph_pattern_coverage': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!(config as any).enablePatterns) {
          return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
        }

        // Load all pattern rules to enumerate coverage
        const { PatternLibraryLoader } = await import('../patterns/loader');
        const loader = new PatternLibraryLoader();
        const builtinPath = path.join(__dirname, '../patterns/library');
        const customPath = (config as any).patternLibraryPath as string | undefined;
        let rules: import('../patterns/types').PatternRule[] = [];
        try {
          rules = loader.load(builtinPath, customPath);
        } catch { /* no rules — continue */ }

        // Group rules by owaspCategory prefix (A01–A10)
        const rulesByCategory = new Map<string, import('../patterns/types').PatternRule[]>();
        for (const rule of rules) {
          const prefix = rule.owaspCategory.match(/^(A\d{2})/)?.[1] ?? rule.owaspCategory;
          if (!rulesByCategory.has(prefix)) rulesByCategory.set(prefix, []);
          rulesByCategory.get(prefix)!.push(rule);
        }

        // Query match counts from DB if table exists
        const db = cg.getDatabase();
        db.applyPatternsSchema();
        const rawDb = db.getRawDb();
        const matchCountsByCategory = new Map<string, number>();
        try {
          const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExists) {
            const rows: Array<{ owasp_category: string; cnt: number }> = rawDb.all(
              'SELECT owasp_category, COUNT(*) as cnt FROM pattern_matches GROUP BY owasp_category'
            );
            for (const row of rows) {
              const prefix = row.owasp_category.match(/^(A\d{2})/)?.[1] ?? row.owasp_category;
              matchCountsByCategory.set(prefix, (matchCountsByCategory.get(prefix) ?? 0) + row.cnt);
            }
          }
        } catch { /* non-critical */ }

        // All OWASP Top 10 categories
        const owaspTop10 = [
          'A01', 'A02', 'A03', 'A04', 'A05',
          'A06', 'A07', 'A08', 'A09', 'A10',
        ];
        const owaspNames: Record<string, string> = {
          A01: 'Broken Access Control',
          A02: 'Cryptographic Failures',
          A03: 'Injection',
          A04: 'Insecure Design',
          A05: 'Security Misconfiguration',
          A06: 'Vulnerable and Outdated Components',
          A07: 'Identification and Authentication Failures',
          A08: 'Software and Data Integrity Failures',
          A09: 'Security Logging and Monitoring Failures',
          A10: 'Server-Side Request Forgery',
        };

        const covered: string[] = [];
        const uncovered: string[] = [];

        const lines: string[] = [
          '# OWASP Top 10 Pattern Coverage',
          '',
          `Total rules loaded: ${rules.length}`,
          '',
          'Category | Rules | Matches',
          '-------- | ----- | -------',
        ];

        for (const cat of owaspTop10) {
          const catRules = rulesByCategory.get(cat) ?? [];
          const matchCount = matchCountsByCategory.get(cat) ?? 0;
          const label = `${cat}: ${owaspNames[cat] ?? cat}`;
          if (catRules.length > 0) {
            covered.push(label);
            lines.push(`${label} | ${catRules.length} | ${matchCount}`);
          } else {
            uncovered.push(label);
          }
        }

        // Extra categories not in top 10
        for (const [cat, catRules] of rulesByCategory.entries()) {
          if (!owaspTop10.includes(cat)) {
            const matchCount = matchCountsByCategory.get(cat) ?? 0;
            lines.push(`${cat} | ${catRules.length} | ${matchCount}`);
          }
        }

        if (uncovered.length > 0) {
          lines.push('', `Uncovered categories (${uncovered.length}):`, ...uncovered.map(c => `  - ${c}`));
        }

        lines.push('', `Coverage: ${covered.length} / ${owaspTop10.length} OWASP Top 10 categories`);

        return lines.join('\n');
      }

      case 'kirograph_pattern_save_baseline': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!(config as any).enablePatterns) {
          return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
        }

        const label = (args.label as string) ?? 'default';

        const db = cg.getDatabase();
        db.applyPatternsSchema();
        const rawDb = db.getRawDb();

        const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
        if (!tableExists) {
          return 'No pattern_matches table found. Run kirograph index first to populate pattern data.';
        }

        const rows: Array<{ pattern_id: string; cnt: number }> = rawDb.all(
          'SELECT pattern_id, COUNT(*) as cnt FROM pattern_matches GROUP BY pattern_id'
        );

        const baseline: Record<string, number> = {};
        for (const row of rows) {
          baseline[row.pattern_id] = row.cnt;
        }

        const kirographDir = path.join(projectRoot, '.kirograph');
        if (!fs.existsSync(kirographDir)) fs.mkdirSync(kirographDir, { recursive: true });

        const baselinePath = path.join(kirographDir, `pattern-baseline-${label}.json`);
        fs.writeFileSync(baselinePath, JSON.stringify({ label, savedAt: Date.now(), counts: baseline }, null, 2));

        const totalMatches = Object.values(baseline).reduce((s, c) => s + c, 0);
        return `Baseline "${label}" saved: ${Object.keys(baseline).length} patterns, ${totalMatches} total matches → ${baselinePath}`;
      }

      case 'kirograph_pattern_diff': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!(config as any).enablePatterns) {
          return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
        }

        const label = (args.label as string) ?? 'default';
        const baselinePath = path.join(projectRoot, '.kirograph', `pattern-baseline-${label}.json`);

        if (!fs.existsSync(baselinePath)) {
          return `Baseline "${label}" not found. Run kirograph_pattern_save_baseline first.`;
        }

        let baseline: { label: string; savedAt: number; counts: Record<string, number> };
        try {
          baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        } catch {
          return `Failed to read baseline file: ${baselinePath}`;
        }

        const db = cg.getDatabase();
        db.applyPatternsSchema();
        const rawDb = db.getRawDb();

        const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
        const currentCounts: Record<string, number> = {};
        if (tableExists) {
          const rows: Array<{ pattern_id: string; cnt: number }> = rawDb.all(
            'SELECT pattern_id, COUNT(*) as cnt FROM pattern_matches GROUP BY pattern_id'
          );
          for (const row of rows) {
            currentCounts[row.pattern_id] = row.cnt;
          }
        }

        const allPatternIds = new Set([...Object.keys(baseline.counts), ...Object.keys(currentCounts)]);

        const newFindings: Array<{ id: string; count: number }> = [];
        const resolvedFindings: Array<{ id: string; count: number }> = [];
        const unchanged: Array<{ id: string; count: number }> = [];
        const changed: Array<{ id: string; before: number; after: number; delta: number }> = [];

        for (const id of allPatternIds) {
          const before = baseline.counts[id] ?? 0;
          const after = currentCounts[id] ?? 0;
          if (before === 0 && after > 0) {
            newFindings.push({ id, count: after });
          } else if (before > 0 && after === 0) {
            resolvedFindings.push({ id, count: before });
          } else if (before === after) {
            unchanged.push({ id, count: after });
          } else {
            changed.push({ id, before, after, delta: after - before });
          }
        }

        const savedDate = new Date(baseline.savedAt).toISOString().slice(0, 16).replace('T', ' ');
        const lines: string[] = [
          `# Pattern Diff: "${label}" (saved ${savedDate}) → current`,
          '',
          `NEW: ${newFindings.length}  RESOLVED: ${resolvedFindings.length}  CHANGED: ${changed.length}  UNCHANGED: ${unchanged.length}`,
        ];

        if (newFindings.length > 0) {
          lines.push('', '## New Findings (not in baseline)');
          for (const f of newFindings.sort((a, b) => b.count - a.count)) {
            lines.push(`  + ${f.id}: ${f.count} matches`);
          }
        }

        if (resolvedFindings.length > 0) {
          lines.push('', '## Resolved (in baseline, not in current)');
          for (const f of resolvedFindings.sort((a, b) => b.count - a.count)) {
            lines.push(`  - ${f.id}: was ${f.count} matches`);
          }
        }

        if (changed.length > 0) {
          lines.push('', '## Changed');
          for (const f of changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
            const sign = f.delta > 0 ? '+' : '';
            lines.push(`  ~ ${f.id}: ${f.before} → ${f.after} (${sign}${f.delta})`);
          }
        }

        return lines.join('\n');
      }

      // ── Wiki tools ────────────────────────────────────────────────────────────

      case 'kirograph_wiki_ingest': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
          autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
        });
        wiki.initialize();

        const source = args.source as string ?? '';
        const sourceName = args.sourceName as string ?? 'source';
        if (!source) return 'source is required';

        if (config.wikiSynthesisMode === 'local') {
          wiki.queueSource(source, sourceName);
          const count = wiki.getQueueCount();
          return `Source "${sourceName}" queued for local wiki synthesis (${count} in queue). The agentStop hook will run "kirograph wiki synthesize" automatically.`;
        }

        const prompt = wiki.getIngestPrompt(source, sourceName);
        return `WIKI_INGEST_PROMPT\n${prompt}\n\nProduce WIKI_DIFF blocks following SCHEMA.md, then call kirograph_wiki_apply_diff with the diff string.`;
      }

      case 'kirograph_wiki_apply_diff': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph', {
          autoResolveConflicts: (config as any).wikiAutoResolveConflicts ?? false,
        });
        wiki.initialize();

        const diff = args.diff as string ?? '';
        if (!diff) return 'diff is required';

        const result = wiki.applyDiff(diff);
        const lines: string[] = ['✓ Wiki diff applied'];
        if (result.created.length) lines.push(`  Created: ${result.created.join(', ')}`);
        if (result.updated.length) lines.push(`  Updated: ${result.updated.join(', ')}`);
        if (result.conflictsResolved.length) lines.push(`  Conflicts auto-resolved: ${result.conflictsResolved.join(', ')}`);
        if (result.conflictsPending.length) {
          lines.push(`  ⚡ Conflicts pending (${result.conflictsPending.length}):`);
          for (const c of result.conflictsPending) {
            lines.push(`    ${c.page} §${c.section}: "${c.existing}" vs "${c.incoming}" (source: ${c.source})`);
          }
        }
        return lines.join('\n');
      }

      case 'kirograph_wiki_search': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
        wiki.initialize();

        const query = args.query as string ?? '';
        if (!query) return 'query is required';
        const limit = Math.min(Number(args.limit ?? 5), 20);

        const results = wiki.search(query, limit);
        if (results.length === 0) return `No wiki pages found for "${query}".`;

        const lines = [`Wiki Search: ${query}`, ''];
        for (const { page, score } of results) {
          lines.push(`[${page.slug}] ${page.title}  (score: ${score.toFixed(3)})`);
          // Show first non-heading line as preview
          const preview = page.content.split('\n').find(l => l.trim() && !l.startsWith('#'));
          if (preview) lines.push(`  ${preview.trim().slice(0, 120)}`);
          lines.push('');
        }
        return lines.join('\n').trim();
      }

      case 'kirograph_wiki_page': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
        wiki.initialize();

        const slug = args.slug as string ?? '';
        if (!slug) return 'slug is required';

        const page = wiki.getPage(slug);
        if (!page) return `Wiki page "${slug}" not found. Use kirograph_wiki_list to see available pages.`;

        return page.content;
      }

      case 'kirograph_wiki_lint': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
        wiki.initialize();

        const issues = wiki.lint();
        if (issues.length === 0) return '✓ Wiki lint passed — no issues found.';

        const lines = [`Wiki Lint — ${issues.length} issue(s)`, ''];
        for (const issue of issues) {
          const icon = issue.kind === 'contradiction' ? '⚡' : issue.kind === 'orphan' ? '○' : issue.kind === 'broken_link' ? '🔗' : '⚠';
          lines.push(`${icon} [${issue.kind}] ${issue.slug}`);
          lines.push(`  ${issue.detail}`);
          lines.push('');
        }
        return lines.join('\n').trim();
      }

      case 'kirograph_wiki_list': {
        const { loadConfig } = await import('../config');
        const projectRoot = cg.getProjectRoot();
        const config = await loadConfig(projectRoot);
        if (!config.enableWiki) return 'Wiki is not enabled. Set enableWiki: true in .kirograph/config.json';

        const { KiroGraphWiki } = await import('../wiki/index');
        const db = cg.getDatabase();
        db.applyWikiSchema();
        const wiki = new KiroGraphWiki(db.getRawDb(), projectRoot + '/.kirograph');
        wiki.initialize();

        const pages = wiki.listPages();
        if (pages.length === 0) return 'Wiki is empty. Use kirograph_wiki_ingest to add pages.';

        const stats = wiki.getStats();
        const lines = [
          `Wiki — ${stats.pageCount} page(s), ${stats.totalSources} total sources`,
          '',
        ];
        for (const page of pages) {
          const date = new Date(page.updatedAt).toISOString().slice(0, 10);
          lines.push(`  ${page.slug.padEnd(32)} ${page.title}  (${page.sourceCount} src, ${date})`);
        }
        return lines.join('\n');
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }
}
