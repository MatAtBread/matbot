import type {
  Tool, ToolEvent, ToolContext, MatbotPlugin, ToolRegistry, PluginSettings,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MCPServerConfig, MCPPersistedConfig, MCPToolDef } from './types.js';
import { createMCPClient } from './client.js';
import type { MCPClient } from './client.js';

interface ActiveServer {
  config: MCPServerConfig;
  client: MCPClient;
  tools: MCPToolDef[];
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
            message: `MCP server "${serverName}" is no longer connected. Use mcp_add to reconnect.`,
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

export function createMCPPlugin(): MatbotPlugin {
  const activeServers = new Map<string, ActiveServer>();
  let registry: ToolRegistry | undefined;
  let pluginSettings: PluginSettings | undefined;

  async function connectAndRegister(config: MCPServerConfig): Promise<MCPToolDef[]> {
    const client = await createMCPClient(config);
    const tools = await client.listTools();
    activeServers.set(config.name, { config, client, tools });
    for (const toolDef of tools) {
      registry!.register(makeProxyTool(config.name, toolDef, activeServers));
    }
    return tools;
  }

  // ── mcp_add ─────────────────────────────────────────────────────────────────

  const mcpAddTool: Tool = {
    name: 'mcp_add',
    description: `Connect a new MCP (Model Context Protocol) server and register its tools for immediate use.

Supports two transport types:
- **local** — spawns a local process that communicates via stdio (e.g. \`npx @modelcontextprotocol/server-github\`, \`uvx mcp-server-fetch\`, \`node ./my-server.js\`)
- **remote** — connects to an HTTP endpoint using JSON-RPC over POST (with optional SSE response streaming)

Before calling this tool, gather all required information from the user:
1. A short lowercase identifier for the server (e.g. "github", "filesystem", "fetch") — used as a prefix on all tool names as \`mcp__<name>__<tool>\`
2. Whether it is **local** (runs a command on this machine) or **remote** (connects to a URL)
3. For **local**: the exact command to run; any environment variables it needs (e.g. API keys or tokens)
4. For **remote**: the full HTTP endpoint URL; any authentication headers (e.g. \`Authorization: Bearer ...\`)

The connection is validated and tools are discovered before the server is saved. On success, all MCP tools are immediately available in this session.`,
    requires: ['spawn', 'network'],
    inputSchema: {
      type: 'object',
      required: ['name', 'type'],
      properties: {
        name: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]*$',
          description: 'Short lowercase identifier (e.g. "github", "filesystem"). Becomes the prefix for all tool names from this server.',
        },
        type: {
          type: 'string',
          enum: ['local', 'remote'],
          description: '"local" spawns a process via stdio; "remote" connects to an HTTP endpoint.',
        },
        command: {
          type: 'string',
          description: 'Local servers only: command to run (e.g. "npx @modelcontextprotocol/server-github"). Quoted segments are respected.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local servers only: additional command-line arguments appended after the command.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Local servers only: environment variables to set for the server process (e.g. {"GITHUB_TOKEN": "ghp_..."}).',
        },
        endpoint: {
          type: 'string',
          description: 'Remote servers only: the MCP HTTP endpoint URL.',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Remote servers only: HTTP request headers (e.g. {"Authorization": "Bearer token"}).',
        },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        const raw = input as {
          name: string;
          type: 'local' | 'remote';
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          endpoint?: string;
          headers?: Record<string, string>;
        };

        if (activeServers.has(raw.name)) {
          yield { type: 'error', message: `An MCP server named "${raw.name}" is already connected. Remove it with mcp_remove first.` };
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
              command: raw.command!,
              ...(raw.args !== undefined ? { args: raw.args } : {}),
              ...(raw.env !== undefined ? { env: raw.env } : {}),
            }
          : {
              type: 'remote',
              name: raw.name,
              endpoint: raw.endpoint!,
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

        yield {
          type: 'result',
          value: {
            message: `Connected. ${tools.length} tool(s) registered.`,
            tools: tools.map(t => `mcp__${raw.name}__${t.name}`),
          },
        };
      },
    },
  };

  // ── mcp_list ─────────────────────────────────────────────────────────────────

  const mcpListTool: Tool = {
    name: 'mcp_list',
    description: 'List all connected MCP servers and the tools they provide.',
    inputSchema: { type: 'object', properties: {} },
    executor: {
      async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        if (activeServers.size === 0) {
          yield { type: 'result', value: { message: 'No MCP servers connected.', servers: [] } };
          return;
        }

        const servers = Array.from(activeServers.values()).map(s => ({
          name: s.config.name,
          type: s.config.type,
          ...(s.config.type === 'local' ? { command: s.config.command } : { endpoint: s.config.endpoint }),
          tools: s.tools.map(t => ({
            toolName: `mcp__${s.config.name}__${t.name}`,
            description: t.description ?? '',
          })),
        }));

        yield { type: 'result', value: { servers } };
      },
    },
  };

  // ── mcp_remove ───────────────────────────────────────────────────────────────

  const mcpRemoveTool: Tool = {
    name: 'mcp_remove',
    description: 'Disconnect an MCP server and remove it from saved configuration. Registered proxy tools will error until the session is restarted.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'Name of the MCP server to remove.',
        },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const { name } = input as { name: string };

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
      },
    },
  };

  // ── Plugin object ─────────────────────────────────────────────────────────────

  return {
    name: 'mcp',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Connect MCP (Model Context Protocol) servers and expose their tools. Supports local stdio and remote HTTP transports.',
    },
    tools: [mcpAddTool, mcpListTool, mcpRemoveTool],

    async setup(services) {
      registry = services.tools;
      pluginSettings = services.settings('mcp');

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
