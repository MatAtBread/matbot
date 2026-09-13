import type { Tool, ToolContract, ToolResultOf, ToolContext, FormField, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, CONFIRM_YES, CONFIRM_NO } from '@matatbread/matbot-plugin-api';
import { RemoteMcpManager } from './manager.js';

// Connecting a server is privileged — it registers a remote party's tools for the rest of the session —
// so it gates on an out-of-band yes/no, as does disconnecting one. A structured `confirm` field so rich
// frontends render real buttons and the affirmative is the canonical token, never a parse of the rendered
// label. The CONFIRM_NO default is what makes a non-interactive caller decline rather than proceed.
export async function confirmAction(ctx: ToolContext, label: string): Promise<boolean> {
  const field: FormField = { name: 'confirm', label, type: 'confirm', default: CONFIRM_NO };
  return (await ctx.prompt(field)).trim().toLowerCase() === CONFIRM_YES;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // Declared identically to the node `mcp` plugin (which hard-deps and overrides this tool with a
    // local+remote superset): a shared tool name is one merged `ToolContracts` entry, so both declarations
    // must match. Standalone (browser) mcp-http implements only the `remote` add — a `local` call there is
    // a graceful runtime error.
    mcp_action:
      | ToolContract<{ message: string; tools: string[]; instructions?: string }, { action: 'add'; name: string; type: 'local'; command: string; args?: string[]; env?: Record<string, string>; proxyToolName?: string } | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string, string>; proxyToolName?: string }>
      | ToolContract<{ servers: unknown[] },                                       { action: 'list' }>
      | ToolContract<{ message: string },                                          { action: 'remove'; name: string }>;
  }
}

type McpRemoteAction =
  | { action: 'add'; name: string; endpoint: string; headers?: Record<string, string>; proxyToolName?: string }
  | { action: 'list' }
  | { action: 'remove'; name: string };

function remoteMcpActionTool(manager: RemoteMcpManager): Tool<ToolResultOf<'mcp_action'>> {
  return {
    name: 'mcp_action',
    description: `Manage remote MCP (Model Context Protocol) server connections over HTTP. An MCP server
exposes a set of tools; once connected, each is registered under \`mcp__<server>__<tool>\` (the
\`mcp__<server>__\` prefix is overridable per server via \`proxyToolName\`) and is callable
until you remove it.

This is the cross-platform (browser + Node) build: it speaks JSON-RPC over HTTP POST (with optional
SSE response streaming). Local stdio servers are not available here — they need the Node mcp plugin.

ACTIONS
  add    — Connect a remote server and register its tools. Validated before saving; some servers
           return usage 'instructions' on connect, surfaced in the result and by 'list'.
  list   — Show connected servers, their tools, and any instructions.
  remove — Disconnect a server and forget it; its proxy tools are unregistered immediately.`,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['add', 'list', 'remove'], description: 'add: connect a server. list: show servers. remove: disconnect.' },
        name:     { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', description: 'Short lowercase server id (add/remove); becomes the tool-name prefix.' },
        endpoint: { type: 'string', description: 'add only: the MCP HTTP endpoint URL.' },
        headers:  { type: 'object', additionalProperties: { type: 'string' }, description: 'add only: HTTP headers, e.g. {"Authorization":"Bearer …"}.' },
        proxyToolName: { type: 'string', description: 'add only: prefix for this server\'s tool names, replacing the default "mcp__<name>__". Persisted; reconnects keep it.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const act = input as McpRemoteAction;
        switch (act.action) {
          case 'add': {
            if (!act.name || !act.endpoint) { yield { type: 'error', message: 'add requires "name" and "endpoint".' }; return; }
            if (!await confirmAction(ctx,
              `Connect to MCP server **"${act.name}"** at ${act.endpoint}?\n\n_Its tools are registered and callable until you remove it._`)) {
              yield { type: 'result', value: { message: 'Cancelled.' } };
              return;
            }
            yield { type: 'stdout', chunk: `Connecting to MCP server "${act.name}"...\n` };
            try {
              const r = await manager.add({ name: act.name, endpoint: act.endpoint, ...(act.headers !== undefined ? { headers: act.headers } : {}), ...(act.proxyToolName !== undefined ? { proxyToolName: act.proxyToolName } : {}) });
              yield { type: 'result', value: { message: `Connected. ${r.tools.length} tool(s) registered.`, tools: r.tools, ...(r.instructions !== undefined ? { instructions: r.instructions } : {}) } };
            } catch (e) { yield { type: 'error', message: `Failed to connect to "${act.name}": ${String(e)}` }; }
            return;
          }
          case 'list':
            yield { type: 'result', value: { servers: manager.list() } };
            return;
          case 'remove': {
            if (!act.name) { yield { type: 'error', message: 'remove requires "name".' }; return; }
            if (!await confirmAction(ctx, `Remove MCP server **"${act.name}"**?`)) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }
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
