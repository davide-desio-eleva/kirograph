/**
 * Stdio JSON-RPC transport for MCP
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

export class StdioTransport {
  private buffer = '';

  start(handler: (msg: JsonRpcMessage) => Promise<unknown>): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMessage;
          const result = await handler(msg);
          if ('id' in msg && msg.id !== undefined) {
            this.send({ jsonrpc: '2.0', id: msg.id, result });
          }
        } catch (err) {
          process.stderr.write(`[KiroGraph MCP] Parse error: ${err}\n`);
        }
      }
    });
  }

  send(msg: object): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
}
