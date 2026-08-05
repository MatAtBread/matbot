import type { MatbotMachine, Tool } from '@matatbread/matbot-core';

// Shared harness for the two tool-collision tests. They live in separate files on purpose: the plugin
// registry (and the cached "always overwrite" choice) is module-global, so two collision tests in one
// file influence each other's path through resolveToolCollision — one of them then passes vacuously.
// node:test runs each file in its own process, which is the isolation the registry does not provide.
export const collider = new URL('./collides-tool.ts', import.meta.url).href;

export const incumbent: Tool = {
  name:        'contested',
  description: 'the tool already in the registry',
  pluginName:  'the-incumbent',
  inputSchema: { type: 'object', properties: {} },
  async *execute() { yield { type: 'result', result: 'from the incumbent' }; },
};

export function machine(): { services: MatbotMachine; tools: Map<string, Tool> } {
  const tools = new Map<string, Tool>([[incumbent.name, incumbent]]);
  const services = {
    resolver:   undefined,
    tools: {
      register: (t: Tool) => { tools.set(t.name, t); },
      remove:   (n: string) => { tools.delete(n); },
      resolve:  (n: string) => tools.get(n) ?? null,
      list:     () => [...tools.values()],
      removeByPlugin: (p: string) => { for (const [n, t] of tools) if (t.pluginName === p) tools.delete(n); },
    },
    Notifier:    { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
    createStore: () => ({
      get:    async () => null,
      set:    async () => {},
      cas:    async () => ({ ok: true }),
      delete: async () => {},
    }),
    mounted:       { observe() {} },
    hooks:         { register() {}, removeByPlugin() {} },
    systemContext: { register() {}, removeByPlugin() {}, build: async () => '' },
    register:   async () => {},
    unregister: () => {},
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine;
  return { services, tools };
}
