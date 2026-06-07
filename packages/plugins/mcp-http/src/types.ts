export interface MCPRemoteConfig {
  type:     'remote';
  name:     string;
  endpoint: string;
  headers?: Record<string, string>;
}

export interface MCPPersistedRemote {
  servers: MCPRemoteConfig[];
}

export interface MCPToolDef {
  name:         string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type MCPContentPart =
  | { type: 'text';     text: string }
  | { type: 'image';    data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface MCPToolResult {
  content?: MCPContentPart[];
  isError?: boolean;
}

/** Transport-agnostic MCP client. mcp-http provides the HTTP impl; a node plugin can provide stdio. */
export interface MCPClient {
  readonly instructions: string | undefined;
  listTools(): Promise<MCPToolDef[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult>;
  close(): void;
}

export interface MCPRemoteServerInfo {
  name:          string;
  endpoint:      string;
  instructions?: string;
  tools:         Array<{ toolName: string; description: string }>;
}

/**
 * The delegation surface mcp-http registers under `services.mcpRemote`. A more capable plugin (e.g.
 * the node mcp plugin, which also speaks stdio) consumes this to handle *remote* servers without
 * re-implementing the HTTP transport — it owns local servers and delegates remote ones here.
 */
export interface McpRemoteService {
  /** Connect a remote MCP server, register its proxy tools, and persist it. */
  add(config: { name: string; endpoint: string; headers?: Record<string, string> }): Promise<{ tools: string[]; instructions?: string }>;
  /** Connected remote servers (for `list`). */
  list(): MCPRemoteServerInfo[];
  /** Whether `name` is a remote server this service manages. */
  has(name: string): boolean;
  /** Disconnect, unregister tools, and forget a remote server. `false` if not managed here. */
  remove(name: string): Promise<boolean>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** Registered by @matatbread/matbot-mcp-http: manage remote (HTTP/SSE) MCP servers. */
    mcpRemote?: McpRemoteService;
  }
}
