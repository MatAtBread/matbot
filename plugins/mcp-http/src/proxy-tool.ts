import type { Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import type { MCPClient, MCPToolDef } from './types.js';

/** The matbot tool name a server's tool is registered under. */
export const proxyToolName = (serverName: string, tool: string): string => `mcp__${serverName}__${tool}`;

/**
 * Build the matbot proxy tool for one MCP tool. `resolveClient` is called per invocation so the tool
 * always uses the live connection (and reports cleanly if the server has since disconnected). Shared
 * by both transports — mcp-http for remote servers, the node mcp plugin for local ones.
 */
export function makeProxyTool(
  serverName:    string,
  toolDef:       MCPToolDef,
  resolveClient: (serverName: string) => MCPClient | undefined,
): Tool {
  return {
    name:        proxyToolName(serverName, toolDef.name),
    description: `[MCP:${serverName}] ${toolDef.description ?? toolDef.name}`,
    inputSchema: toolDef.inputSchema ?? { type: 'object', properties: {} },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const client = resolveClient(serverName);
        if (client === undefined) {
          yield { type: 'error', message: `MCP server "${serverName}" is no longer connected. Use mcp_action (add) to reconnect.` };
          return;
        }
        let result;
        try {
          result = await client.callTool(toolDef.name, input, ctx.signal);
        } catch (e) {
          yield { type: 'error', message: `MCP tool call failed: ${String(e)}` };
          return;
        }
        if (!result?.content) { yield { type: 'result', value: result }; return; }

        let text = '';
        for (const part of result.content) if (part.type === 'text') text += part.text;
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
