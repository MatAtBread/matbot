import type { MatbotServices, PluginSettings } from '@matatbread/matbot-plugin-api';
import type {
  MCPClient, MCPRemoteConfig, MCPToolDef, MCPPersistedRemote, MCPRemoteServerInfo, McpRemoteService,
} from './types.js';
import { createHttpClient } from './client.js';
import { makeProxyTool, proxyToolName } from './proxy-tool.js';

interface ActiveRemote { config: MCPRemoteConfig; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

const PERSIST_KEY = 'servers';

/**
 * Owns the live remote MCP connections, their proxy-tool registrations, and persistence. Implements
 * {@link McpRemoteService} so a more capable plugin can delegate remote work here. Persists through
 * the injected {@link PluginSettings} (store/vault path) — portable, no filesystem.
 */
export class RemoteMcpManager implements McpRemoteService {
  private readonly active = new Map<string, ActiveRemote>();

  constructor(private readonly services: MatbotServices, private readonly settings: PluginSettings) {}

  private resolveClient = (name: string): MCPClient | undefined => this.active.get(name)?.client;

  private async connect(config: MCPRemoteConfig): Promise<MCPToolDef[]> {
    const client = await createHttpClient(config);
    const tools  = await client.listTools();
    this.active.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const toolDef of tools) {
      this.services.tools.register(makeProxyTool(config.name, toolDef, this.resolveClient));
    }
    return tools;
  }

  async add(input: { name: string; endpoint: string; headers?: Record<string, string> }): Promise<{ tools: string[]; instructions?: string }> {
    if (this.active.has(input.name)) throw new Error(`An MCP server named "${input.name}" is already connected.`);
    const config: MCPRemoteConfig = {
      type: 'remote', name: input.name, endpoint: input.endpoint,
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
    };
    const tools = await this.connect(config);

    const persisted = (await this.settings.get<MCPPersistedRemote>(PERSIST_KEY)) ?? { servers: [] };
    persisted.servers.push(config);
    await this.settings.set(PERSIST_KEY, persisted);

    const instructions = this.active.get(input.name)?.instructions;
    return {
      tools: tools.map(t => proxyToolName(input.name, t.name)),
      ...(instructions !== undefined ? { instructions } : {}),
    };
  }

  list(): MCPRemoteServerInfo[] {
    return [...this.active.values()].map(s => ({
      name:     s.config.name,
      endpoint: s.config.endpoint,
      ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      tools:    s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name), description: t.description ?? '' })),
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
      for (const toolDef of server.tools) this.services.tools.remove(proxyToolName(name, toolDef.name));
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
    for (const config of persisted?.servers ?? []) {
      try { await this.connect(config); } catch (e) { onError(config.name, e); }
    }
  }

  closeAll(): void {
    for (const s of this.active.values()) s.client.close();
    this.active.clear();
  }
}
