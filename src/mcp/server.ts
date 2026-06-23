/**
 * KiroGraph MCP Server
 * Implements the Model Context Protocol over stdio.
 */

import * as path from 'path';
import KiroGraph, { findNearestKiroGraphRoot } from '../index';
import { StdioTransport, ErrorCodes } from './transport';
import { tools, ToolHandler, LIVE_SEARCH_TOOL_DEFINITION } from './tools';
import { FEATURE_TOOL_SETS } from './tool-names';
import { PatternRunner } from '../patterns/runner';
import type { JsonRpcMessage } from './transport';

const SERVER_INFO = { name: 'kirograph', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

export class MCPServer {
  private transport = new StdioTransport();
  private cg: KiroGraph | null = null;
  private toolHandler: ToolHandler;
  private projectPath: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private config: any | null = null;
  private enabledTools: typeof tools = [];
  private enabledToolNames = new Set<string>();

  constructor(projectPath?: string) {
    // Normalize to absolute path immediately to prevent any path traversal
    this.projectPath = projectPath ? path.resolve(projectPath) : null;
    this.toolHandler = new ToolHandler(null);
    this.setEnabledTools(); // default: all tools until config loads
  }

  async start(): Promise<void> {
    // Load config before the transport starts so tools/list is never served stale.
    if (this.projectPath) await this.tryInit(this.projectPath);
    this.transport.start(this.handleMessage.bind(this));
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
    process.stdin.on('end', () => this.stop());
    process.stdin.on('close', () => this.stop());
  }

  private async tryInit(projectPath: string): Promise<void> {
    const root = findNearestKiroGraphRoot(projectPath);
    if (!root) { this.projectPath = projectPath; return; }
    this.projectPath = root;
    try {
      this.cg = await KiroGraph.open(root);
      this.toolHandler.setDefaultKiroGraph(this.cg);
    } catch (err) {
      process.stderr.write(`[KiroGraph MCP] Failed to open ${root}: ${err}\n`);
    }
    try {
      const { loadConfig } = await import('../config');
      this.config = await loadConfig(root);
    } catch {
      // config is optional — proceed without it
    }
    this.setEnabledTools();

    // Start PixelRAG server if visual PDF search is enabled (experimental)
    if (this.config?.enableVisualPDF && root) {
      this._startPixelRAG(root, this.config.pixelragPort).catch(err => {
        process.stderr.write(`[KiroGraph MCP] PixelRAG startup failed: ${err?.message ?? err}\n`);
      });
    }
  }

  private async _startPixelRAG(projectRoot: string, port: number): Promise<void> {
    const path2 = await import('path');
    const { ensurePython, ensurePixelRAGInstalled, startServer } = await import('../data/pixelrag-manager');
    const kirographDir = path2.join(projectRoot, '.kirograph');
    const python = ensurePython();
    ensurePixelRAGInstalled(python);
    await startServer(python, port, kirographDir);
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<unknown> {
    const req = msg as any;

    switch (req.method) {
      case 'initialize': {
        // If start() already loaded config from --path, skip re-init.
        // If no config yet (no --path), try the rootUri sent by the IDE.
        if (!this.config) {
          const rootUri = req.params?.rootUri ?? req.params?.workspaceFolders?.[0]?.uri;
          if (rootUri) {
            const p = rootUri.startsWith('file://') ? decodeURIComponent(rootUri.replace(/^file:\/\/\/?/, '')) : rootUri;
            await this.tryInit(p);
          }
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
      }

      case 'tools/list': {
        return { tools: this.enabledTools };
      }

      case 'tools/call': {
        const { name, arguments: args = {} } = req.params ?? {};
        if (!this.enabledToolNames.has(name)) {
          return {
            content: [{ type: 'text', text: `Tool "${name}" is not available. The feature it belongs to is not enabled in .kirograph/config.json.` }],
            isError: true,
          };
        }
        try {
          return await this.toolHandler.handle(name, args);
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }

      case 'notifications/initialized':
      case 'ping':
        return {};

      default:
        this.transport.sendError(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`);
        return undefined;
    }
  }

  private setEnabledTools(): void {
    // Only exclude a tool when its feature flag is explicitly false.
    // undefined = not in config (old install) = keep the tool.
    const hidden = new Set<string>();
    if (this.config) {
      for (const [flag, names] of Object.entries(FEATURE_TOOL_SETS)) {
        if (this.config[flag] === false) {
          for (const n of names) hidden.add(n);
        }
      }
    }
    const list = tools.filter(t => !hidden.has(t.name));
    if (this.config?.enablePatterns && new PatternRunner().isAvailable()) {
      list.push(LIVE_SEARCH_TOOL_DEFINITION);
    }
    this.enabledTools = list;
    this.enabledToolNames = new Set(list.map(t => t.name));
  }

  private stop(): void {
    this.cg?.close();
    this.toolHandler.closeAll();
    process.exit(0);
  }
}
