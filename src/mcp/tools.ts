/**
 * KiroGraph MCP Tool Definitions + Handlers
 */

import KiroGraph, { findNearestKiroGraphRoot } from '../index';
import type { NodeKind } from '../types';

const MAX_OUTPUT = 15_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[truncated]' : s;
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
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'kirograph_context',
    description: 'PRIMARY TOOL: Build comprehensive context for a task. Returns entry points, related symbols, and key code — often enough to understand the codebase without additional tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task, bug, or feature to build context for' },
        maxNodes: { type: 'number', description: 'Max symbols to include (default: 20)', default: 20 },
        includeCode: { type: 'boolean', description: 'Include code snippets (default: true)', default: true },
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
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
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
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
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
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kirograph_status',
    description: 'Check index health and statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export class ToolHandler {
  private cg: KiroGraph | null;

  constructor(cg: KiroGraph | null) {
    this.cg = cg;
  }

  setDefaultKiroGraph(cg: KiroGraph): void {
    this.cg = cg;
  }

  async handle(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const text = await this.dispatch(toolName, args);
    return { content: [{ type: 'text', text: truncate(text) }] };
  }

  private async dispatch(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.cg) return 'KiroGraph not initialized. Run `kirograph init` in your project first.';

    switch (toolName) {
      case 'kirograph_search': {
        const results = this.cg.searchNodes(
          args.query as string,
          args.kind as NodeKind | undefined,
          (args.limit as number) ?? 10
        );
        if (results.length === 0) return `No symbols found matching "${args.query}".`;
        return results.map(r =>
          `${r.node.kind} ${r.node.name}\n  File: ${r.node.filePath}:${r.node.startLine}\n  Qualified: ${r.node.qualifiedName}`
        ).join('\n\n');
      }

      case 'kirograph_context': {
        const ctx = await this.cg.buildContext(args.task as string, {
          maxNodes: (args.maxNodes as number) ?? 20,
          includeCode: (args.includeCode as boolean) ?? true,
        });
        const lines: string[] = [ctx.summary, ''];
        lines.push('## Entry Points');
        for (const n of ctx.entryPoints) {
          lines.push(`- ${n.kind} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
          if (ctx.codeSnippets.has(n.id)) {
            lines.push('```', ctx.codeSnippets.get(n.id)!, '```');
          }
        }
        if (ctx.relatedNodes.length > 0) {
          lines.push('', '## Related Symbols');
          for (const n of ctx.relatedNodes.slice(0, 10)) {
            lines.push(`- ${n.kind} \`${n.name}\` — ${n.filePath}:${n.startLine}`);
          }
        }
        return lines.join('\n');
      }

      case 'kirograph_callers': {
        const results = this.cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const callers = this.cg.getCallers(node.id, (args.limit as number) ?? 20);
        if (callers.length === 0) return `No callers found for \`${node.name}\`.`;
        return `Callers of \`${node.name}\`:\n` + callers.map(n =>
          `- ${n.kind} \`${n.name}\` — ${n.filePath}:${n.startLine}`
        ).join('\n');
      }

      case 'kirograph_callees': {
        const results = this.cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const callees = this.cg.getCallees(node.id, (args.limit as number) ?? 20);
        if (callees.length === 0) return `\`${node.name}\` doesn't call any indexed symbols.`;
        return `\`${node.name}\` calls:\n` + callees.map(n =>
          `- ${n.kind} \`${n.name}\` — ${n.filePath}:${n.startLine}`
        ).join('\n');
      }

      case 'kirograph_impact': {
        const results = this.cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const affected = this.cg.getImpactRadius(node.id, (args.depth as number) ?? 2);
        if (affected.length === 0) return `No dependents found for \`${node.name}\`.`;
        return `Changing \`${node.name}\` may affect ${affected.length} symbol(s):\n` +
          affected.map(n => `- ${n.kind} \`${n.name}\` — ${n.filePath}:${n.startLine}`).join('\n');
      }

      case 'kirograph_node': {
        const results = this.cg.searchNodes(args.symbol as string, undefined, 5);
        if (results.length === 0) return `Symbol "${args.symbol}" not found in index.`;
        const node = results[0].node;
        const lines = [
          `${node.kind} \`${node.name}\``,
          `File: ${node.filePath}:${node.startLine}-${node.endLine}`,
          `Qualified: ${node.qualifiedName}`,
          node.signature ? `Signature: ${node.signature}` : '',
          node.docstring ? `Docs: ${node.docstring}` : '',
        ].filter(Boolean);
        if (args.includeCode) {
          const src = this.cg.getNodeSource(node);
          if (src) lines.push('', '```', src, '```');
        }
        return lines.join('\n');
      }

      case 'kirograph_status': {
        const stats = this.cg.getStats();
        return [
          `KiroGraph Status`,
          `  Project: ${this.cg.getProjectRoot()}`,
          `  Files indexed: ${stats.files}`,
          `  Symbols: ${stats.nodes}`,
          `  Relationships: ${stats.edges}`,
          `  By kind: ${Object.entries(stats.nodesByKind).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        ].join('\n');
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }
}
