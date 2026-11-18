import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPlugin, PLUGIN_API_VERSION } from '@matatbread/matbot-core';
import type { MatbotMachine, MatbotPlugin, Tool } from '@matatbread/matbot-core';

/**
 * Two things a plugin's own machine must not reach, because a plugin that hands a model a name-driven
 * capability (tool-store's generated stores) hands the model whatever the plugin can reach:
 *
 *  - the raw `settings` namespace, which holds every plugin's settings — the default gate's standing
 *    answers among them, so writing it grants anything; a plugin has `settings()` for its own.
 *  - another plugin's tool, through `tools.remove`: remove-then-register replaces it without the
 *    `tools.overwrite` collision ever being decided.
 */

function hostMachine() {
  const tools  = new Map<string, Tool>();
  const opened: string[] = [];
  const removedBy: string[] = [];
  const machine = {
    tools: {
      register: (t: Tool) => { tools.set(t.name, t); },
      remove:   (n: string) => { tools.delete(n); },
      resolve:  (n: string) => tools.get(n) ?? null,
      list:     () => [...tools.values()],
      removeByPlugin: (n: string) => { removedBy.push(`tools:${n}`); },
    },
    Notifier:      { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
    createStore:   (ns: string) => { opened.push(ns); return { get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }; },
    mounted:       { observe() {} },
    hooks:         { register() {}, removeByPlugin: (n: string) => { removedBy.push(`hooks:${n}`); } },
    systemContext: { register() {}, removeByPlugin: (n: string) => { removedBy.push(`systemContext:${n}`); }, build: async () => '', parts: async () => [] },
    register:      async () => {},
    unregister:    () => {},
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine;
  return { machine, tools, opened, removedBy };
}

async function scopedFor(machine: MatbotMachine, name: string): Promise<MatbotMachine> {
  let scoped!: MatbotMachine;
  const plugin = {
    apiVersion: PLUGIN_API_VERSION, name, specifier: name,
    async setup(services: MatbotMachine) { scoped = services; },
  } as unknown as MatbotPlugin;
  await setupPlugin(plugin, machine);
  return scoped;
}

const tool = (name: string, pluginName?: string): Tool => ({
  name, description: '', inputSchema: { type: 'object', properties: {} },
  ...(pluginName !== undefined ? { pluginName } : {}),
  executor: { async *execute() {} },
} as unknown as Tool);

test("a plugin cannot open the settings namespace, in any case", async () => {
  const { machine, opened } = hostMachine();
  const scoped = await scopedFor(machine, 'opener');
  for (const ns of ['settings', 'Settings', 'SETTINGS'])
    assert.throws(() => scoped.createStore(ns), /cannot open the "\w+" store/);
  scoped.createStore('notes');
  assert.ok(opened.includes('notes'), 'any other namespace opens as before');
});

test("a plugin's store name is a word, so no spelling of a path reaches the settings directory", async () => {
  const { machine, opened } = hostMachine();
  const scoped = await scopedFor(machine, 'opener');
  for (const ns of ['./settings', 'settings/', 'x/../settings', 'settings.', '', 'a b'])
    assert.throws(() => scoped.createStore(ns), /letters, digits/, ns);
  scoped.createStore('my-store_2');
  assert.deepEqual(opened.filter(n => n !== 'settings'), ['my-store_2']);
});

test("a plugin removes its own tools, and nobody else's", async () => {
  const { machine, tools } = hostMachine();
  tools.set('gate_action', tool('gate_action'));
  tools.set('theirs', tool('theirs', 'other-plugin'));
  const scoped = await scopedFor(machine, 'remover');
  scoped.tools.register(tool('mine'));

  scoped.tools.remove('gate_action');
  scoped.tools.remove('theirs');
  scoped.tools.remove('mine');
  scoped.tools.remove('absent');

  assert.ok(tools.has('gate_action'), "the host's tool stays");
  assert.ok(tools.has('theirs'), "another plugin's tool stays");
  assert.ok(!tools.has('mine'), 'its own tool goes');
});

test("removeByPlugin reaches only the calling plugin's own registrations", async () => {
  const { machine, removedBy } = hostMachine();
  const scoped = await scopedFor(machine, 'remover');
  for (const name of ['other-plugin', undefined as unknown as string]) {
    scoped.tools.removeByPlugin(name);
    scoped.hooks.removeByPlugin(name);
    scoped.systemContext.removeByPlugin(name);
  }
  assert.deepEqual(removedBy, [], "another plugin's, and the host's (no pluginName), stay");
  scoped.tools.removeByPlugin('remover');
  scoped.hooks.removeByPlugin('remover');
  scoped.systemContext.removeByPlugin('remover');
  assert.deepEqual(removedBy, ['tools:remover', 'hooks:remover', 'systemContext:remover']);
});
