import type { MatbotMachine, PluginSettings } from '@matatbread/matbot-plugin-api';
import type {
  MCPClient, MCPRemoteConfig, MCPToolDef, MCPPersistedRemote, MCPRemoteServerInfo, McpRemoteService,
} from './types.js';
import { createHttpClient, type HttpMCPClient } from './client.js';
import { makeProxyTool, proxyToolName } from './proxy-tool.js';

interface ActiveRemote { config: MCPRemoteConfig; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

const PERSIST_KEY = 'servers';

// How long a server has to answer `initialize` + `tools/list`. Unbounded, a server that accepted the
// connection and never replied held its caller for ever — at boot, every later plugin with it.
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Owns the live remote MCP connections, their proxy-tool registrations, and persistence. Implements
 * {@link McpRemoteService} so a more capable plugin can delegate remote work here. Persists through
 * the injected {@link PluginSettings} (store/vault path) — portable, no filesystem.
 */
export class RemoteMcpManager implements McpRemoteService {
  private readonly active = new Map<string, ActiveRemote>();
  private readonly services: MatbotMachine;
  private readonly settings: PluginSettings;
  // Aborted by closeAll(): a handshake still in flight at teardown must not register proxy tools for a
  // plugin that has gone.
  private readonly closed = new AbortController();

  constructor(services: MatbotMachine, settings: PluginSettings) {
    this.services = services;
    this.settings = settings;
  }

  private resolveClient = (name: string): MCPClient | undefined => this.active.get(name)?.client;

  private async connect(config: MCPRemoteConfig): Promise<MCPToolDef[]> {
    const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS)]);
    let client: HttpMCPClient;
    let tools:  MCPToolDef[];
    try {
      client = await createHttpClient(config, signal);
      tools  = await client.listTools(signal);
    } catch (e) {
      if (this.closed.signal.aborted) throw new Error(`MCP client closed while connecting to "${config.name}".`);
      if (signal.aborted) throw new Error(`MCP server "${config.name}" (${config.endpoint}) did not answer within ${HANDSHAKE_TIMEOUT_MS / 1000}s.`);
      throw e;
    }
    // Record the probed protocol-version-header policy so callers can persist it (see add / reconnect).
    if (client.protocolVersion !== undefined) config.protocolVersion = client.protocolVersion;
    this.active.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const toolDef of tools) {
      this.services.tools.register(makeProxyTool(config.name, toolDef, this.resolveClient, config.proxyToolName));
    }
    return tools;
  }

  async add(input: { name: string; endpoint: string; headers?: Record<string, string>; proxyToolName?: string }): Promise<{ tools: string[]; instructions?: string }> {
    if (this.active.has(input.name)) throw new Error(`An MCP server named "${input.name}" is already connected.`);
    const config: MCPRemoteConfig = {
      type: 'remote', name: input.name, endpoint: input.endpoint,
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.proxyToolName !== undefined ? { proxyToolName: input.proxyToolName } : {}),
    };
    const tools = await this.connect(config);

    const persisted = (await this.settings.get<MCPPersistedRemote>(PERSIST_KEY)) ?? { servers: [] };
    persisted.servers.push(config);
    await this.settings.set(PERSIST_KEY, persisted);

    const instructions = this.active.get(input.name)?.instructions;
    return {
      tools: tools.map(t => proxyToolName(input.name, t.name, config.proxyToolName)),
      ...(instructions !== undefined ? { instructions } : {}),
    };
  }

  list(): MCPRemoteServerInfo[] {
    return [...this.active.values()].map(s => ({
      name:     s.config.name,
      endpoint: s.config.endpoint,
      ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      tools:    s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name, s.config.proxyToolName), description: t.description ?? '' })),
    }));
  }

  has(name: string): boolean { return this.active.has(name); }

  async remove(name: string): Promise<boolean> {
    const persisted = await this.settings.get<MCPPersistedRemote>(PERSIST_KEY);
    const inConfig  = persisted?.servers.some(s => s.name === name) ?? false;
    const server    = this.active.get(name);
    if (server === undefined && !inConfig) return false;

    if (server) {
      server.client.close();
      for (const toolDef of server.tools) this.services.tools.remove(proxyToolName(name, toolDef.name, server.config.proxyToolName));
      this.active.delete(name);
    }
    if (persisted) {
      persisted.servers = persisted.servers.filter(s => s.name !== name);
      await this.settings.set(PERSIST_KEY, persisted);
    }
    return true;
  }

  async reconnectPersisted(onError: (name: string, err: unknown) => void): Promise<void> {
    const persisted = await this.settings.get<MCPPersistedRemote>(PERSIST_KEY);
    if (persisted === undefined) return;
    let dirty = false;
    // Concurrently: one slow server must not hold back the others' tools.
    await Promise.all(persisted.servers.map(async config => {
      const before = config.protocolVersion;
      try {
        await this.connect(config);
        if (config.protocolVersion !== before) dirty = true;
      } catch (e) { if (!this.closed.signal.aborted) onError(config.name, e); }
    }));
    if (dirty && !this.closed.signal.aborted) await this.settings.set(PERSIST_KEY, persisted);
  }

  closeAll(): void {
    this.closed.abort();
    for (const s of this.active.values()) s.client.close();
    this.active.clear();
  }
}
