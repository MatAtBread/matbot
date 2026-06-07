import type {
  Tool, ToolEvent, ToolContext, MatbotPluginSpec, ToolRegistry, PluginSettings,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MCPServerConfig, MCPPersistedConfig, MCPToolDef } from './types.js';
import { createMCPClient } from './client.js';
import type { MCPClient } from './client.js';

interface ActiveServer {
  config: MCPServerConfig;
  client: MCPClient;
  tools: MCPToolDef[];
  instructions?: string;
}

// ── Proxy tool factory ────────────────────────────────────────────────────────

function makeProxyTool(
  serverName: string,
  toolDef: MCPToolDef,
  activeServers: Map<string, ActiveServer>,
): Tool {
  return {
    name: `mcp__${serverName}__${toolDef.name}`,
    description: `[MCP:${serverName}] ${toolDef.description ?? toolDef.name}`,
    inputSchema: toolDef.inputSchema ?? { type: 'object', properties: {} },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const server = activeServers.get(serverName);
        if (!server) {
          yield {
            type: 'error',
            message: `MCP server "${serverName}" is no longer connected. Use mcp_action (add) to reconnect.`,
          };
          return;
        }

        let result;
        try {
          result = await server.client.callTool(toolDef.name, input, ctx.signal);
        } catch (e) {
          yield { type: 'error', message: `MCP tool call failed: ${String(e)}` };
          return;
        }

        if (!result?.content) {
          yield { type: 'result', value: result };
          return;
        }

        let text = '';
        for (const part of result.content) {
          if (part.type === 'text') text += part.text;
        }

        if (result.isError) {
          yield { type: 'error', message: text || 'MCP tool returned an error' };
        } else {
          if (text) yield { type: 'stdout', chunk: text };
          yield { type: 'result', value: result.content };
        }
      },
    },
  };
}

// ── Plugin factory ────────────────────────────────────────────────────────────

export function createMCPPlugin(): MatbotPluginSpec {
  const activeServers = new Map<string, ActiveServer>();
  let registry: ToolRegistry | undefined;
  let pluginSettings: PluginSettings | undefined;

  async function connectAndRegister(config: MCPServerConfig): Promise<MCPToolDef[]> {
    const client = await createMCPClient(config);
    const tools = await client.listTools();
    activeServers.set(config.name, {
      config,
      client,
      tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const toolDef of tools) {
      registry!.register(makeProxyTool(config.name, toolDef, activeServers));
    }
    return tools;
  }

  // ── mcp_action ────────────────────────────────────────────────────────────────

  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string, string> }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string, string> }
    | { action: 'list' }
    | { action: 'remove'; name: string };

  async function* doAdd(raw: Extract<McpAction, { action: 'add' }>): AsyncIterable<ToolEvent> {
    if (activeServers.has(raw.name)) {
      yield { type: 'error', message: `An MCP server named "${raw.name}" is already connected. Remove it (action 'remove') first.` };
      return;
    }
    if (raw.type === 'local' && !raw.command) {
      yield { type: 'error', message: 'Local MCP servers require a "command" parameter.' };
      return;
    }
    if (raw.type === 'remote' && !raw.endpoint) {
      yield { type: 'error', message: 'Remote MCP servers require an "endpoint" parameter.' };
      return;
    }

    const config: MCPServerConfig = raw.type === 'local'
      ? {
          type: 'local',
          name: raw.name,
          command: raw.command,
          ...(raw.args !== undefined ? { args: raw.args } : {}),
          ...(raw.env !== undefined ? { env: raw.env } : {}),
        }
      : {
          type: 'remote',
          name: raw.name,
          endpoint: raw.endpoint,
          ...(raw.headers !== undefined ? { headers: raw.headers } : {}),
        };

    yield { type: 'stdout', chunk: `Connecting to MCP server "${raw.name}"...\n` };

    let tools: MCPToolDef[];
    try {
      tools = await connectAndRegister(config);
    } catch (e) {
      yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` };
      return;
    }

    const persisted = (await pluginSettings!.get<MCPPersistedConfig>('servers')) ?? { servers: [] };
    persisted.servers.push(config);
    await pluginSettings!.set('servers', persisted);

    const instructions = activeServers.get(raw.name)?.instructions;
    yield {
      type: 'result',
      value: {
        message: `Connected. ${tools.length} tool(s) registered.`,
        tools: tools.map(t => `mcp__${raw.name}__${t.name}`),
        ...(instructions !== undefined ? { instructions } : {}),
      },
    };
  }

  async function* doList(): AsyncIterable<ToolEvent> {
    if (activeServers.size === 0) {
      yield { type: 'result', value: { message: 'No MCP servers connected.', servers: [] } };
      return;
    }

    const servers = Array.from(activeServers.values()).map(s => ({
      name: s.config.name,
      type: s.config.type,
      ...(s.config.type === 'local' ? { command: s.config.command } : { endpoint: s.config.endpoint }),
      ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      tools: s.tools.map(t => ({
        toolName: `mcp__${s.config.name}__${t.name}`,
        description: t.description ?? '',
      })),
    }));

    yield { type: 'result', value: { servers } };
  }

  async function* doRemove(name: string, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const persisted = await pluginSettings!.get<MCPPersistedConfig>('servers');
    const inConfig = persisted?.servers.some(s => s.name === name) ?? false;

    if (!activeServers.has(name) && !inConfig) {
      yield { type: 'error', message: `No MCP server named "${name}" found.` };
      return;
    }

    const confirm = await ctx.prompt(`Remove MCP server "${name}"? [y/N]`, 'N');
    if (!/^y(es)?$/i.test(confirm.trim())) {
      yield { type: 'result', value: { message: 'Cancelled.' } };
      return;
    }

    const server = activeServers.get(name);
    if (server) {
      server.client.close();
      for (const toolDef of server.tools) {
        registry!.remove(`mcp__${name}__${toolDef.name}`);
      }
      activeServers.delete(name);
    }

    if (persisted) {
      persisted.servers = persisted.servers.filter(s => s.name !== name);
      await pluginSettings!.set('servers', persisted);
    }

    yield {
      type: 'result',
      value: {
        message: `"${name}" disconnected and removed. Its tools have been unregistered.`,
      },
    };
  }

  const mcpActionTool: Tool = {
    name: 'mcp_action',
    description: `Manage MCP (Model Context Protocol) server connections. An MCP server exposes a
set of tools over a transport; once connected, each of its tools is registered
under the name \`mcp__<server>__<tool>\` and is callable for the rest of the session.

Two transport types:
- **local** — spawns a process on this machine that speaks JSON-RPC over stdio
  (e.g. \`npx @modelcontextprotocol/server-github\`, \`uvx mcp-server-fetch\`, \`node ./my-server.js\`).
- **remote** — connects to an HTTP endpoint that speaks JSON-RPC over POST
  (optionally with SSE response streaming).

ACTIONS
  add    — Connect a server and register its tools. The connection is validated
           and tools are discovered before the config is saved; on success the
           tools are usable immediately. Some servers return usage 'instructions'
           on connect — these are surfaced in the result and by 'list'.
  list   — Show all connected servers, their tools, and any server instructions.
  remove — Disconnect a server and delete it from saved config. Its proxy tools
           are unregistered immediately.

Before calling 'add', gather from the user: a short lowercase server identifier;
whether it is local or remote; for local the exact command and any env vars
(API keys/tokens); for remote the endpoint URL and any auth headers.

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
        action: {
          type: 'string',
          enum: ['add', 'list', 'remove'],
          description: "add: connect a server. list: show connected servers. remove: disconnect a server.",
        },
        name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]*$',
          description: 'Short lowercase server identifier (add/remove). Becomes the prefix for all tool names from this server.',
        },
        type: {
          type: 'string',
          enum: ['local', 'remote'],
          description: 'add only: "local" spawns a process via stdio; "remote" connects to an HTTP endpoint.',
        },
        command: {
          type: 'string',
          description: 'add, local only: command to run (e.g. "npx @modelcontextprotocol/server-github"). Quoted segments are respected.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'add, local only: additional command-line arguments appended after the command.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'add, local only: environment variables for the server process (e.g. {"GITHUB_TOKEN": "ghp_..."}).',
        },
        endpoint: {
          type: 'string',
          description: 'add, remote only: the MCP HTTP endpoint URL.',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'add, remote only: HTTP request headers (e.g. {"Authorization": "Bearer token"}).',
        },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const act = input as McpAction;

        switch (act.action) {
          case 'add':
            yield* doAdd(act);
            return;
          case 'list':
            yield* doList();
            return;
          case 'remove':
            yield* doRemove(act.name, ctx);
            return;
          default:
            yield { type: 'error', message: `Unknown mcp_action "${(act as { action: string }).action}". Expected one of: add, list, remove.` };
        }
      },
    },
  };

  // ── Plugin object ─────────────────────────────────────────────────────────────

  return {
    apiVersion: PLUGIN_API_VERSION,
    tools: [mcpActionTool],

    async setup(services) {
      registry = services.tools;
      pluginSettings = services.settings();

      const persisted = await pluginSettings.get<MCPPersistedConfig>('servers');
      for (const config of persisted?.servers ?? []) {
        try {
          await connectAndRegister(config);
        } catch (e) {
          process.stderr.write(`[mcp] Failed to reconnect "${config.name}": ${String(e)}\n`);
        }
      }
    },

    async teardown() {
      for (const server of activeServers.values()) {
        server.client.close();
      }
      activeServers.clear();
    },
  };
}
