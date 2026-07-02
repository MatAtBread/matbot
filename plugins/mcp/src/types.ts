export interface MCPServerConfigLocal {
  type:     'local';
  name:     string;
  command:  string;
  args?:    string[];
  env?:     Record<string, string>;
  /** Prefix for this server's proxy-tool names. Default `mcp__<name>__`; persisted so reconnects keep the same names. */
  proxyToolName?: string;
}

export interface MCPPersistedLocal {
  servers: MCPServerConfigLocal[];
}
