import type { MatbotMachine, Tool } from '@matatbread/matbot-core';

// Shared harness for the two tool-collision tests. They live in separate files on purpose: the plugin
// registry (and the cached "always overwrite" choice) is module-global, so two collision tests in one
// file influence each other's path through resolveToolCollision — one of them then passes vacuously.
// node:test runs each file in its own process, which is the isolation the registry does not provide.
export const collider      = new URL('./collides-tool.ts', import.meta.url).href;
export const otherCollider = new URL('./collides-other-tool.ts', import.meta.url).href;
export const twinCollider  = new URL('./collides-tool-twin.ts', import.meta.url).href;

const held = (name: string): Tool => ({
  name,
  description: 'the tool already in the registry',
  pluginName:  'the-incumbent',
  inputSchema: { type: 'object', properties: {} },
  async *execute() { yield { type: 'result', result: 'from the incumbent' }; },
});

export const incumbent = held('contested');

export function machine(): { services: MatbotMachine; tools: Map<string, Tool>; docs: Map<string, unknown> } {
  const tools = new Map<string, Tool>([incumbent, held('other-contested')].map(t => [t.name, t]));
  // A real (in-memory) store, not a stub returning null: what an "always" answer PERSISTS is part of
  // the collision contract, and a stub swallowing the write makes that unobservable.
  const docs = new Map<string, unknown>();
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
      get:    async (id: string) => docs.get(id) ?? null,
      set:    async (id: string, doc: unknown) => { docs.set(id, doc); },
      cas:    async (id: string, _v: string, doc: unknown) => { docs.set(id, doc); return { ok: true }; },
      delete: async (id: string) => { docs.delete(id); },
    }),
    mounted:       { observe() {} },
    hooks:         { register() {}, removeByPlugin() {} },
    systemContext: { register() {}, removeByPlugin() {}, build: async () => '', parts: async () => [] },
    register:   async () => {},
    unregister: () => {},
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine;
  return { services, tools, docs };
}
