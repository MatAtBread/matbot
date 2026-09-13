import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPlugin, PLUGIN_API_VERSION } from '@matatbread/matbot-core';
import type { MatbotMachine, MatbotPlugin, PermissionGate, PermissionRequest } from '@matatbread/matbot-core';

/**
 * What a plugin reads through its own scoped machine must be the LIVE policy, not a copy taken when it
 * loaded. `setupPlugin` builds that machine with `{ ...services }`, which evaluates every getter on the
 * host object exactly once — harmless for the swap-members that hand back capture-safe proxies, and not
 * harmless for `PermissionGate`, which is deliberately un-proxied so a policy can capture the gate it
 * displaces. Copied, a plugin holding `services.PermissionGate` would consult whatever was active when
 * IT loaded: a policy registered afterwards would never be reached (frontend-web's `POST /tools/:name`
 * route reads exactly this way), and unloading one would leave the copy on the gone impl rather than
 * reverting to the host's default.
 *
 * The delegation tests next door use a host-shaped registry and cannot see this — the scoped machine is
 * the layer between them and a real plugin.
 */

const gateNamed = (name: string): PermissionGate =>
  ({ async decide(_req: PermissionRequest) { return name === 'allow'; } });

function hostMachine(boot: PermissionGate) {
  let active = boot;
  const tools = new Map<string, unknown>();
  const machine = {
    get PermissionGate() { return active; },
    register:   async (key: string, value: unknown) => { if (key === 'PermissionGate') active = value as PermissionGate; },
    unregister: (key: string) => { if (key === 'PermissionGate') active = boot; },
    tools: {
      register: (t: { name: string }) => { tools.set(t.name, t); },
      remove:   (n: string) => { tools.delete(n); },
      resolve:  (n: string) => tools.get(n) ?? null,
      list:     () => [...tools.values()],
      removeByPlugin: () => {},
    },
    Notifier:      { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
    createStore:   () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
    mounted:       { observe() {} },
    hooks:         { register() {}, removeByPlugin() {} },
    systemContext: { register() {}, removeByPlugin() {}, build: async () => '', parts: async () => [] },
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine;
  return { machine, swap: (g: PermissionGate) => { active = g; }, revert: () => { active = boot; } };
}

test('a plugin reads the live gate through its scoped machine, not a load-time copy', async () => {
  const { machine, swap, revert } = hostMachine(gateNamed('deny'));

  // A plugin that consults the policy per call — what frontend-web does for `POST /tools/:name`.
  let scoped!: MatbotMachine;
  const plugin: MatbotPlugin = {
    apiVersion: PLUGIN_API_VERSION,
    name:       'reader',
    specifier:  'reader',
    async setup(services) { scoped = services; },
  } as unknown as MatbotPlugin;
  await setupPlugin(plugin, machine);

  const req: PermissionRequest = { gate: 'plugin.add', subject: '@x/foo', label: 'l', fallback: false };
  assert.equal(await scoped.PermissionGate.decide(req, undefined), false, 'the boot policy decides');

  // A policy registered AFTER this plugin loaded must be the one it consults.
  swap(gateNamed('allow'));
  assert.equal(await scoped.PermissionGate.decide(req, undefined), true);

  // And unloading that policy must land back on the host's boot default, not on the gone impl.
  revert();
  assert.equal(await scoped.PermissionGate.decide(req, undefined), false);
});
