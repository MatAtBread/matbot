export interface MCPServerConfigLocal {
  type: 'local';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPServerConfigRemote {
  type: 'remote';
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export type MCPServerConfig = MCPServerConfigLocal | MCPServerConfigRemote;

export interface MCPPersistedConfig {
  servers: MCPServerConfig[];
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type MCPContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface MCPToolResult {
  content?: MCPContentPart[];
  isError?: boolean;
}
