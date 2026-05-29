import { spawn } from 'node:child_process';
import process from 'node:process';
import type { MCPServerConfig, MCPToolDef, MCPToolResult } from './types.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'matbot', version: '0.1.0' };
const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface MCPClient {
  listTools(): Promise<MCPToolDef[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult>;
  close(): void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Simple shell-like tokenizer: respects single and double quotes.
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) { quote = ''; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ── Stdio transport ───────────────────────────────────────────────────────────

class StdioMCPClient implements MCPClient {
  private readonly child;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private buf = '';
  private dead = false;

  constructor(command: string, extraArgs: string[], env?: Record<string, string>) {
    const parts = tokenize(command);
    const exe = parts[0] ?? command;
    const args = [...parts.slice(1), ...extraArgs];

    this.child = spawn(exe, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });

    this.child.on('close', () => {
      this.dead = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('MCP server process exited unexpectedly'));
      }
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof msg.id !== 'number') return;

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private write(msg: JsonRpcRequest | JsonRpcNotification): void {
    this.child.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('MCP client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.request('tools/list') as { tools?: MCPToolDef[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult> {
    if (signal?.aborted) throw new Error('Aborted');
    const result = await this.request('tools/call', { name, arguments: args });
    return result as MCPToolResult;
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.child.kill('SIGTERM');
  }
}

// ── HTTP transport ────────────────────────────────────────────────────────────

class HttpMCPClient implements MCPClient {
  private readonly endpoint: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private nextId = 1;

  constructor(endpoint: string, extraHeaders?: Record<string, string>) {
    this.endpoint = endpoint;
    this.extraHeaders = extraHeaders;
  }

  private async post(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
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
    const result = await this.post('tools/call', { name, arguments: args }, signal);
    return result as MCPToolResult;
  }

  close(): void { /* HTTP is stateless */ }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createMCPClient(config: MCPServerConfig): Promise<MCPClient> {
  if (config.type === 'local') {
    const client = new StdioMCPClient(config.command, config.args ?? [], config.env);
    await client.initialize();
    return client;
  }

  return new HttpMCPClient(config.endpoint, config.headers);
}
