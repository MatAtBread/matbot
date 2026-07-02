import type { Tool, ToolEvent, ToolResult, ToolResultOf, ToolContext, MatbotPluginSpec, MatbotMachine, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    mcp_action:
      | ToolResult<{ message: string; tools: string[]; instructions?: string }, { action: 'add'    }>
      | ToolResult<{ servers: unknown[] },                                       { action: 'list'   }>
      | ToolResult<{ message: string },                                          { action: 'remove' }>;
  }
}
import type { MCPClient, MCPToolDef, MCPRemoteConfig } from '@matatbread/matbot-mcp-http';
import { makeProxyTool, proxyToolName, RemoteMcpManager } from '@matatbread/matbot-mcp-http';
import process from 'node:process';
import type { MCPServerConfigLocal, MCPPersistedLocal } from './types.js';
import { createStdioClient } from './client.js';

interface ActiveLocal { config: MCPServerConfigLocal; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

// RemoteMcpManager persists under a fixed 'servers' key; scope it beneath ours so the embedded remote
// store never collides with our local 'servers'. One settings document, two non-overlapping owners.
function remoteSettings(base: PluginSettings): PluginSettings {
  const scoped = (key: string): string => `remote:${key}`;
  return {
    get:    <T>(key: string) => base.get<T>(scoped(key)),
    set:    <T>(key: string, value: T) => base.set<T>(scoped(key), value),
    delete: (key: string) => base.delete(scoped(key)),
  };
}

/**
 * The node MCP plugin. It hard-depends on @matatbread/matbot-mcp-http (declared in package.json) and
 * embeds its RemoteMcpManager directly — no second plugin load, no service discovery. It exposes one
 * `mcp_action` tool spanning both transports: local (stdio) servers handled here, remote (HTTP) ones
 * delegated to the embedded manager. Owning the manager outright keeps its whole lifecycle (connect,
 * reconnect, teardown) under this plugin, so there is no order-dependent cleanup between two plugins.
 */
export function createMCPPlugin(): MatbotPluginSpec {
  const localActive = new Map<string, ActiveLocal>();
  let settings: PluginSettings | undefined;
  let remote:   RemoteMcpManager | undefined;
  let registry: MatbotMachine['tools'] | undefined;

  const resolveLocalClient = (name: string): MCPClient | undefined => localActive.get(name)?.client;

  async function connectLocal(config: MCPServerConfigLocal): Promise<MCPToolDef[]> {
    const client = await createStdioClient(config.command, config.args ?? [], config.env);
    const tools  = await client.listTools();
    localActive.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const t of tools) registry!.register(makeProxyTool(config.name, t, resolveLocalClient, config.proxyToolName));
    return tools;
  }

  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string, string>; proxyToolName?: string }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string, string>; proxyToolName?: string }
    | { action: 'list' }
    | { action: 'remove'; name: string };

  async function* doAdd(raw: Extract<McpAction, { action: 'add' }>): AsyncIterable<ToolEvent<ToolResultOf<'mcp_action'>>> {
    if (localActive.has(raw.name) || remote!.has(raw.name)) {
      yield { type: 'error', message: `An MCP server named "${raw.name}" is already connected. Remove it first.` };
      return;
    }

    if (raw.type === 'remote') {
      if (!raw.endpoint) { yield { type: 'error', message: 'Remote MCP servers require an "endpoint".' }; return; }
      yield { type: 'stdout', chunk: `Connecting to remote MCP server "${raw.name}"...\n` };
      try {
        const r = await remote!.add({ name: raw.name, endpoint: raw.endpoint, ...(raw.headers !== undefined ? { headers: raw.headers } : {}), ...(raw.proxyToolName !== undefined ? { proxyToolName: raw.proxyToolName } : {}) });
        yield { type: 'result', value: { message: `Connected. ${r.tools.length} tool(s) registered.`, tools: r.tools, ...(r.instructions !== undefined ? { instructions: r.instructions } : {}) } };
      } catch (e) { yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` }; }
      return;
    }

    if (!raw.command) { yield { type: 'error', message: 'Local MCP servers require a "command".' }; return; }
    const config: MCPServerConfigLocal = {
      type: 'local', name: raw.name, command: raw.command,
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.env  !== undefined ? { env:  raw.env  } : {}),
      ...(raw.proxyToolName !== undefined ? { proxyToolName: raw.proxyToolName } : {}),
    };
    yield { type: 'stdout', chunk: `Spawning local MCP server "${raw.name}"...\n` };
    let tools: MCPToolDef[];
    try { tools = await connectLocal(config); }
    catch (e) { yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` }; return; }

    const persisted = (await settings!.get<MCPPersistedLocal>('servers')) ?? { servers: [] };
    persisted.servers.push(config);
    await settings!.set('servers', persisted);

    const instructions = localActive.get(raw.name)?.instructions;
    yield { type: 'result', value: {
      message: `Connected. ${tools.length} tool(s) registered.`,
      tools: tools.map(t => proxyToolName(raw.name, t.name, config.proxyToolName)),
      ...(instructions !== undefined ? { instructions } : {}),
    } };
  }

  function* listLocal(): Generator<unknown> {
    for (const s of localActive.values()) {
      yield {
        name: s.config.name, type: 'local', command: s.config.command,
        ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
        tools: s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name, s.config.proxyToolName), description: t.description ?? '' })),
      };
    }
  }

  async function* doRemove(name: string, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'mcp_action'>>> {
    // Remote servers belong to the delegated service; everything else is local.
    if (remote!.has(name)) {
      const confirm = await ctx.prompt(`Remove MCP server "${name}"? [y/N]`, 'N');
      if (!/^y(es)?$/i.test(confirm.trim())) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }
      const ok = await remote!.remove(name);
      yield { type: 'result', value: { message: ok ? `"${name}" disconnected and removed.` : `No MCP server named "${name}".` } };
      return;
    }

    const persisted = await settings!.get<MCPPersistedLocal>('servers');
    const inConfig  = persisted?.servers.some(s => s.name === name) ?? false;
    if (!localActive.has(name) && !inConfig) { yield { type: 'error', message: `No MCP server named "${name}".` }; return; }

    const confirm = await ctx.prompt(`Remove MCP server "${name}"? [y/N]`, 'N');
    if (!/^y(es)?$/i.test(confirm.trim())) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }

    const server = localActive.get(name);
    if (server) {
      server.client.close();
      for (const t of server.tools) registry!.remove(proxyToolName(name, t.name, server.config.proxyToolName));
      localActive.delete(name);
    }
    if (persisted) { persisted.servers = persisted.servers.filter(s => s.name !== name); await settings!.set('servers', persisted); }
    yield { type: 'result', value: { message: `"${name}" disconnected and removed. Its tools have been unregistered.` } };
  }

  const mcpActionTool: Tool<ToolResultOf<'mcp_action'>> = {
    name: 'mcp_action',
    description: `Manage MCP (Model Context Protocol) server connections. An MCP server exposes a set
of tools over a transport; once connected, each is registered under \`mcp__<server>__<tool>\` (the
\`mcp__<server>__\` prefix is overridable per server via \`proxyToolName\`) and is callable for the
rest of the session.

Two transport types:
- **local** — spawns a process on this machine speaking JSON-RPC over stdio
  (e.g. \`npx @modelcontextprotocol/server-github\`, \`uvx mcp-server-fetch\`).
- **remote** — connects to an HTTP endpoint (JSON-RPC over POST, optional SSE).

ACTIONS
  add    — Connect a server and register its tools (validated before saving).
  list   — Show connected servers, their tools, and any server instructions.
  remove — Disconnect a server and forget it; its proxy tools are unregistered.

SHAPE  (TypeScript)
  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string,string>; proxyToolName?: string }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string,string>; proxyToolName?: string }
    | { action: 'list' }
    | { action: 'remove'; name: string };`,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['add', 'list', 'remove'], description: 'add: connect a server. list: show servers. remove: disconnect.' },
        name:     { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', description: 'Short lowercase server id (add/remove); becomes the tool-name prefix.' },
        type:     { type: 'string', enum: ['local', 'remote'], description: 'add only: "local" spawns a process via stdio; "remote" connects to an HTTP endpoint.' },
        command:  { type: 'string', description: 'add, local only: command to run (quoted segments respected).' },
        args:     { type: 'array', items: { type: 'string' }, description: 'add, local only: extra arguments appended after the command.' },
        env:      { type: 'object', additionalProperties: { type: 'string' }, description: 'add, local only: environment variables for the server process.' },
        endpoint: { type: 'string', description: 'add, remote only: the MCP HTTP endpoint URL.' },
        headers:  { type: 'object', additionalProperties: { type: 'string' }, description: 'add, remote only: HTTP headers, e.g. {"Authorization":"Bearer …"}.' },
        proxyToolName: { type: 'string', description: 'add only: prefix for this server\'s tool names, replacing the default "mcp__<name>__". Persisted; reconnects keep it.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const act = input as McpAction;
        switch (act.action) {
          case 'add':    yield* doAdd(act); return;
          case 'list':   yield { type: 'result', value: { servers: [...listLocal(), ...remote!.list().map(s => ({ ...s, type: 'remote' }))] } }; return;
          case 'remove': yield* doRemove(act.name, ctx); return;
          default:       yield { type: 'error', message: `Unknown mcp_action "${(act as { action: string }).action}".` };
        }
      },
    },
  };

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'MCP servers (local stdio + remote HTTP). Embeds @matatbread/matbot-mcp-http\'s remote client directly.' },
    // No static tools: mcp_action is registered in setup(), once the embedded RemoteMcpManager exists
    // for its executor to delegate remote work to.

    async setup(services) {
      registry = services.tools;
      settings = services.settings();

      // Embed the remote client directly (hard dependency, satisfied by this package's node_modules).
      // We own it outright — its connect, reconnect, and teardown all run here.
      remote = new RemoteMcpManager(services, remoteSettings(settings));
      registry.register(mcpActionTool);

      // Reconnect remote servers from the manager's own (sub-scoped) store.
      await remote.reconnectPersisted((name, e) =>
        process.stderr.write(`[mcp] Failed to reconnect remote "${name}": ${String(e)}\n`));

      // Reconnect locals, and self-heal the pre-split layout where local *and* remote servers shared
      // our 'servers' key. Remote entries found there are handed to the manager (which re-persists them
      // under its sub-key) and dropped from this list; locals reconnect and stay.
      type PersistedMixed = { servers: Array<MCPServerConfigLocal | MCPRemoteConfig> };
      const persisted = await settings.get<PersistedMixed>('servers');
      if (persisted?.servers?.length) {
        const keep: Array<MCPServerConfigLocal | MCPRemoteConfig> = [];
        for (const config of persisted.servers) {
          try {
            if (config.type === 'remote') {
              if (!remote.has(config.name)) {
                await remote.add({ name: config.name, endpoint: config.endpoint, ...(config.headers !== undefined ? { headers: config.headers } : {}), ...(config.proxyToolName !== undefined ? { proxyToolName: config.proxyToolName } : {}) });
              }
            } else {
              await connectLocal(config);
              keep.push(config);
            }
          } catch (e) {
            process.stderr.write(`[mcp] Failed to reconnect "${config.name}": ${String(e)}\n`);
            keep.push(config);   // keep on failure so a transient outage doesn't lose the config
          }
        }
        if (keep.length !== persisted.servers.length) await settings.set('servers', { servers: keep });
      }
    },

    async teardown() {
      for (const s of localActive.values()) s.client.close();
      localActive.clear();
      remote?.closeAll();
    },
  };
}
