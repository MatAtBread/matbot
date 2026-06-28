import type { MCPClient, MCPRemoteConfig, MCPToolDef, MCPToolResult } from './types.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'matbot', version: '0.1.0' };

interface JsonRpcRequest  { jsonrpc: '2.0'; id: number; method: string; params: unknown }
interface JsonRpcResponse { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }

/**
 * MCP client over HTTP — JSON-RPC POST, with optional SSE response framing. Pure `fetch`, so it runs
 * unchanged in the browser and Node. (The stdio transport, which needs child processes, lives in the
 * node-only mcp plugin.)
 */
export class HttpMCPClient implements MCPClient {
  instructions: string | undefined;
  private nextId = 1;
  private readonly endpoint: string;
  private readonly extraHeaders: Record<string, string> | undefined;

  constructor(endpoint: string, extraHeaders?: Record<string, string>) {
    this.endpoint = endpoint;
    this.extraHeaders = extraHeaders;
  }

  // Best-effort: stateless HTTP MCP servers serve tools/call without an init handshake, so a server
  // that rejects initialize must not block the connection. We only want the `instructions` if offered.
  async initialize(): Promise<void> {
    try {
      const result = await this.post('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities:    {},
        clientInfo:      CLIENT_INFO,
      }) as { instructions?: unknown };
      if (typeof result?.instructions === 'string') this.instructions = result.instructions;
    } catch { /* stateless server / no initialize support */ }
  }

  private async post(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const headers: Record<string, string> = {
      'Content-Type':         'application/json',
      'Accept':               'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.extraHeaders,
    };

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
    }

    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const text = await resp.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let msg: JsonRpcResponse;
        try { msg = JSON.parse(line.slice(6)) as JsonRpcResponse; } catch { continue; }
        if (msg.id === id) {
          if (msg.error) throw new Error(msg.error.message);
          return msg.result;
        }
      }
      throw new Error('No matching response found in SSE stream');
    }

    const data = await resp.json() as JsonRpcResponse;
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.post('tools/list') as { tools?: MCPToolDef[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult> {
    return await this.post('tools/call', { name, arguments: args }, signal) as MCPToolResult;
  }

  close(): void { /* HTTP is stateless */ }
}

export async function createHttpClient(config: MCPRemoteConfig): Promise<HttpMCPClient> {
  const client = new HttpMCPClient(config.endpoint, config.headers);
  await client.initialize();
  return client;
}
