export { plugin, createMcpHttpPlugin } from './plugin.js';
export { RemoteMcpManager }            from './manager.js';
export { HttpMCPClient, createHttpClient } from './client.js';
export { makeProxyTool, proxyToolName } from './proxy-tool.js';
export type {
  MCPClient, MCPToolDef, MCPToolResult, MCPContentPart,
  MCPRemoteConfig, MCPRemoteServerInfo, McpRemoteService,
} from './types.js';
