import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec, MatbotServices, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MCPClient, MCPToolDef, McpRemoteService } from '@matatbread/matbot-mcp-http';
import { makeProxyTool, proxyToolName } from '@matatbread/matbot-mcp-http';
import process from 'node:process';
import type { MCPServerConfigLocal, MCPPersistedLocal } from './types.js';
import { createStdioClient } from './client.js';

interface ActiveLocal { config: MCPServerConfigLocal; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

// Specifier of the cross-platform remote plugin this one is built on. Resolved via *this* package's
// node_modules (it's a package.json dependency), so the dependency travels with the plugin — the
// user configures only the node mcp plugin, never the http one.
const MCP_HTTP = '@matatbread/matbot-mcp-http';

/**
 * The node MCP plugin. It hard-depends on @matatbread/matbot-mcp-http (declared in package.json),
 * pulls it in itself, and *takes over* its `mcp_action` tool with a combined local+remote one of the
 * same shape — handling local (stdio) servers directly and delegating remote (HTTP) ones to the
 * mcpRemote service. One tool, two transports, one implementation of each.
 */
export function createMCPPlugin(): MatbotPluginSpec {
  const localActive = new Map<string, ActiveLocal>();
  let settings: PluginSettings | undefined;
  let remote:   McpRemoteService | undefined;
  let registry: MatbotServices['tools'] | undefined;

  const resolveLocalClient = (name: string): MCPClient | undefined => localActive.get(name)?.client;

  async function connectLocal(config: MCPServerConfigLocal): Promise<MCPToolDef[]> {
    const client = await createStdioClient(config.command, config.args ?? [], config.env);
    const tools  = await client.listTools();
    localActive.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const t of tools) registry!.register(makeProxyTool(config.name, t, resolveLocalClient));
    return tools;
  }

  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string, string> }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string, string> }
    | { action: 'list' }
    | { action: 'remove'; name: string };

  async function* doAdd(raw: Extract<McpAction, { action: 'add' }>): AsyncIterable<ToolEvent> {
    if (localActive.has(raw.name) || remote!.has(raw.name)) {
      yield { type: 'error', message: `An MCP server named "${raw.name}" is already connected. Remove it first.` };
      return;
    }

    if (raw.type === 'remote') {
      if (!raw.endpoint) { yield { type: 'error', message: 'Remote MCP servers require an "endpoint".' }; return; }
      yield { type: 'stdout', chunk: `Connecting to remote MCP server "${raw.name}"...\n` };
      try {
        const r = await remote!.add({ name: raw.name, endpoint: raw.endpoint, ...(raw.headers !== undefined ? { headers: raw.headers } : {}) });
        yield { type: 'result', value: { message: `Connected. ${r.tools.length} tool(s) registered.`, tools: r.tools, ...(r.instructions !== undefined ? { instructions: r.instructions } : {}) } };
      } catch (e) { yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` }; }
      return;
    }

    if (!raw.command) { yield { type: 'error', message: 'Local MCP servers require a "command".' }; return; }
    const config: MCPServerConfigLocal = {
      type: 'local', name: raw.name, command: raw.command,
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.env  !== undefined ? { env:  raw.env  } : {}),
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
      tools: tools.map(t => proxyToolName(raw.name, t.name)),
      ...(instructions !== undefined ? { instructions } : {}),
    } };
  }

  function* listLocal(): Generator<unknown> {
    for (const s of localActive.values()) {
      yield {
        name: s.config.name, type: 'local', command: s.config.command,
        ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
        tools: s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name), description: t.description ?? '' })),
      };
    }
  }

  async function* doRemove(name: string, ctx: ToolContext): AsyncIterable<ToolEvent> {
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
      for (const t of server.tools) registry!.remove(proxyToolName(name, t.name));
      localActive.delete(name);
    }
    if (persisted) { persisted.servers = persisted.servers.filter(s => s.name !== name); await settings!.set('servers', persisted); }
    yield { type: 'result', value: { message: `"${name}" disconnected and removed. Its tools have been unregistered.` } };
  }

  const mcpActionTool: Tool = {
    name: 'mcp_action',
    description: `Manage MCP (Model Context Protocol) server connections. An MCP server exposes a set
of tools over a transport; once connected, each is registered under \`mcp__<server>__<tool>\` and is
callable for the rest of the session.

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
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string,string> }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string,string> }
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
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
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
    manifest: { description: 'MCP servers (local stdio + remote HTTP). Hard-depends on @matatbread/matbot-mcp-http and takes over its mcp_action.' },
    // No static tools: we register mcp_action in setup() *after* loading the remote plugin, so our
    // combined tool deliberately overrides the remote-only one it registered.

    async setup(services) {
      registry = services.tools;
      settings = services.settings();

      // Hard dependency, satisfied by this package — not the user's config. Pull in the remote plugin
      // (it registers the mcpRemote service + a remote-only mcp_action), then grab its service.
      remote = services.get('mcpRemote');
      if (remote === undefined) {
        await services.loadPlugin(import.meta.resolve(MCP_HTTP));
        remote = services.get('mcpRemote');
      }
      if (remote === undefined) throw new Error(`mcp: required dependency "${MCP_HTTP}" did not register its mcpRemote service`);

      // Take over: register our combined local+remote mcp_action, overriding the remote-only one.
      registry.register(mcpActionTool);

      // Reconnect persisted local servers (remote ones are reconnected by the delegated plugin).
      const persisted = await settings.get<MCPPersistedLocal>('servers');
      for (const config of persisted?.servers ?? []) {
        try { await connectLocal(config); }
        catch (e) { process.stderr.write(`[mcp] Failed to reconnect "${config.name}": ${String(e)}\n`); }
      }
    },

    async teardown() {
      for (const s of localActive.values()) s.client.close();
      localActive.clear();
    },
  };
}
