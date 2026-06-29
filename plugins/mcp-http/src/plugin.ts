import type { Tool, ToolResult, ToolResultOf, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { RemoteMcpManager } from './manager.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    mcp_action:
      | ToolResult<{ message: string; tools: string[]; instructions?: string }, { action: 'add'    }>
      | ToolResult<{ servers: unknown[] },                                       { action: 'list'   }>
      | ToolResult<{ message: string },                                          { action: 'remove' }>;
  }
}

type McpRemoteAction =
  | { action: 'add'; name: string; endpoint: string; headers?: Record<string, string> }
  | { action: 'list' }
  | { action: 'remove'; name: string };

function remoteMcpActionTool(manager: RemoteMcpManager): Tool<ToolResultOf<'mcp_action'>> {
  return {
    name: 'mcp_action',
    description: `Manage remote MCP (Model Context Protocol) server connections over HTTP. An MCP server
exposes a set of tools; once connected, each is registered under \`mcp__<server>__<tool>\` and is
callable for the rest of the session.

This is the cross-platform (browser + Node) build: it speaks JSON-RPC over HTTP POST (with optional
SSE response streaming). Local stdio servers are not available here — they need the Node mcp plugin.

ACTIONS
  add    — Connect a remote server and register its tools. Validated before saving; some servers
           return usage 'instructions' on connect, surfaced in the result and by 'list'.
  list   — Show connected servers, their tools, and any instructions.
  remove — Disconnect a server and forget it; its proxy tools are unregistered immediately.

SHAPE  (TypeScript)
  type McpAction =
    | { action: 'add'; name: string; endpoint: string; headers?: Record<string,string> }
    | { action: 'list' }
    | { action: 'remove'; name: string };`,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['add', 'list', 'remove'], description: 'add: connect a server. list: show servers. remove: disconnect.' },
        name:     { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', description: 'Short lowercase server id (add/remove); becomes the tool-name prefix.' },
        endpoint: { type: 'string', description: 'add only: the MCP HTTP endpoint URL.' },
        headers:  { type: 'object', additionalProperties: { type: 'string' }, description: 'add only: HTTP headers, e.g. {"Authorization":"Bearer …"}.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const act = input as McpRemoteAction;
        switch (act.action) {
          case 'add': {
            if (!act.name || !act.endpoint) { yield { type: 'error', message: 'add requires "name" and "endpoint".' }; return; }
            yield { type: 'stdout', chunk: `Connecting to MCP server "${act.name}"...\n` };
            try {
              const r = await manager.add({ name: act.name, endpoint: act.endpoint, ...(act.headers !== undefined ? { headers: act.headers } : {}) });
              yield { type: 'result', value: { message: `Connected. ${r.tools.length} tool(s) registered.`, tools: r.tools, ...(r.instructions !== undefined ? { instructions: r.instructions } : {}) } };
            } catch (e) { yield { type: 'error', message: `Failed to connect to "${act.name}": ${String(e)}` }; }
            return;
          }
          case 'list':
            yield { type: 'result', value: { servers: manager.list() } };
            return;
          case 'remove': {
            if (!act.name) { yield { type: 'error', message: 'remove requires "name".' }; return; }
            const confirm = await ctx.prompt(`Remove MCP server "${act.name}"? [y/N]`, 'N');
            if (!/^y(es)?$/i.test(confirm.trim())) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }
            const ok = await manager.remove(act.name);
            yield { type: 'result', value: { message: ok ? `"${act.name}" disconnected and removed.` : `No MCP server named "${act.name}".` } };
            return;
          }
          default:
            yield { type: 'error', message: `Unknown mcp_action "${(act as { action: string }).action}".` };
        }
      },
    },
  };
}

export function createMcpHttpPlugin(): MatbotPluginSpec {
  let manager: RemoteMcpManager | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Cross-platform remote MCP client (HTTP/SSE). Registers mcp_action and the McpRemoteService delegation service.' },

    async setup(services) {
      manager = new RemoteMcpManager(services, services.settings());
      await services.register('McpRemoteService', manager);
      services.tools.register(remoteMcpActionTool(manager));
      await manager.reconnectPersisted((name, err) => console.warn(`[mcp-http] Failed to reconnect "${name}":`, err));
    },

    async teardown() { manager?.closeAll(); },
  };
}

export const plugin: MatbotPluginSpec = createMcpHttpPlugin();
