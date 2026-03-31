/**
 * KiroGraph MCP Tool Definitions + Handlers
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import KiroGraph, { findNearestKiroGraphRoot } from '../index';
import type { NodeKind } from '../types';
import { logError } from '../errors';

const MAX_OUTPUT = 15_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[truncated]' : s;
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
          description: 'Output format: "tree" (default, visual tree), "flat" (one path per line), "grouped" (grouped by directory)',
          enum: ['tree', 'flat', 'grouped'],
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
];

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
      return { content: [{ type: 'text', text: truncate(text) }] };
    } catch (err) {
      logError('MCP tool error', { tool: toolName, error: err });
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  private async dispatch(toolName: string, args: Record<string, unknown>): Promise<string> {
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
        return `Changing \`${node.name}\` may affect ${affected.length} symbol(s):\n` +
          affected.map(n => `- ${mapKind(n.kind)} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');
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
                'in-process cosine'
              }`,
              `  Embeddings:      ${stats.embeddingCount} / ${stats.nodes} symbols`,
            ]
          : [`  Semantic search: disabled`];
        const frameworkLine = stats.frameworks.length > 0
          ? `  Frameworks: ${stats.frameworks.join(', ')}`
          : `  Frameworks: none detected`;
        return [
          `KiroGraph Status`,
          `  Project: ${cg.getProjectRoot()}`,
          `  Files indexed: ${stats.files}`,
          `  Symbols: ${stats.nodes}`,
          `  Relationships: ${stats.edges}`,
          `  By kind: ${Object.entries(stats.nodesByKind).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          langLine ? `  By language: ${langLine}` : '',
          frameworkLine,
          `  DB size: ${dbMb} MB`,
          ...semanticLines,
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

      default:
        return `Unknown tool: ${toolName}`;
    }
  }
}
