import type { MCPClient, MCPRemoteConfig, MCPToolDef, MCPToolResult } from './types.js';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'matbot', version: '0.1.0' };

interface JsonRpcRequest  { jsonrpc: '2.0'; id: number; method: string; params: unknown }
interface JsonRpcResponse { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }

// A reachable server answered with a non-ok status — distinct from a thrown fetch (network/CORS),
// which never reaches the server. The probe adds the protocol-version header only on this. Duck-typed
// (brand + guard, not a class) so the check survives a plugin reload — see plugin-api/src/errors.ts.
interface HttpStatusError extends Error { httpStatus: number }
function httpStatusError(status: number, message: string): HttpStatusError {
  return Object.assign(new Error(message), { httpStatus: status });
}
function isHttpStatusError(e: unknown): e is HttpStatusError {
  return typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).httpStatus === 'number';
}

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
  // The version this server negotiated in `initialize` (its own reply), sent in the MCP-Protocol-Version
  // header on later requests. Falls back to the version we advertise until the server tells us otherwise.
  private negotiatedVersion = DEFAULT_PROTOCOL_VERSION;
  // Resolved header policy: a version string to send, `null` to omit, or `undefined` = not yet probed.
  // Browsers preflight the header and servers that don't allow it reject the request outright, so we
  // default to omitting it and add it back only for a server that demands it. Readable via
  // `protocolVersion` so the manager can persist it and skip the probe on reconnect.
  private headerVersion: string | null | undefined;

  constructor(endpoint: string, extraHeaders?: Record<string, string>, headerVersion?: string | null) {
    this.endpoint = endpoint;
    this.extraHeaders = extraHeaders;
    this.headerVersion = headerVersion;
  }

  /** Resolved header policy: version string (send), `null` (omit), or `undefined` (no request has succeeded yet). */
  get protocolVersion(): string | null | undefined { return this.headerVersion; }

  // Best-effort: stateless HTTP MCP servers serve tools/call without an init handshake, so a server
  // that rejects initialize must not block the connection. We only want the `instructions` if offered.
  async initialize(): Promise<void> {
    try {
      const result = await this.post('initialize', {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities:    {},
        clientInfo:      CLIENT_INFO,
      }) as { protocolVersion?: unknown; instructions?: unknown };
      if (typeof result?.protocolVersion === 'string') this.negotiatedVersion = result.protocolVersion;
      if (typeof result?.instructions === 'string') this.instructions = result.instructions;
      // If we send the header at all, carry the version the server just negotiated (not the one the
      // probe happened to try before the reply arrived).
      if (typeof this.headerVersion === 'string') this.headerVersion = this.negotiatedVersion;
    } catch { /* stateless server / no initialize support */ }
  }

  private async post(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    if (this.headerVersion !== undefined) {
      return this.send(id, body, this.headerVersion, signal);
    }

    // Probe once. Header-less first: it satisfies the narrower CORS preflight, so a server that
    // doesn't allow the MCP-Protocol-Version header still works. Only a *reachable* server that
    // rejects the header-less request (a non-ok HTTP status) is asked again with the header — a
    // thrown fetch (network/opaque CORS) never reached the server, and adding a header can't help it.
    try {
      const result = await this.send(id, body, null, signal);
      this.headerVersion = null;
      return result;
    } catch (e) {
      if (!isHttpStatusError(e)) throw e;
      const result = await this.send(id, body, this.negotiatedVersion, signal);
      this.headerVersion = this.negotiatedVersion;
      return result;
    }
  }

  private async send(id: number, body: JsonRpcRequest, headerVersion: string | null, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept':       'application/json, text/event-stream',
      ...(headerVersion !== null ? { 'MCP-Protocol-Version': headerVersion } : {}),
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
      throw httpStatusError(resp.status, `HTTP ${resp.status}: ${text || resp.statusText}`);
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
  const client = new HttpMCPClient(config.endpoint, config.headers, config.protocolVersion);
  await client.initialize();
  return client;
}
