export interface MCPServerConfigLocal {
  type:     'local';
  name:     string;
  command:  string;
  args?:    string[];
  env?:     Record<string, string>;
}

export interface MCPPersistedLocal {
  servers: MCPServerConfigLocal[];
}
