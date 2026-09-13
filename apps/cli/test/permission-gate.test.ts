import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askPermissionGate, bindGate, installSettingsDefaults, makePluginSettings,
         optionValue, optionLabel } from '@matatbread/matbot-core';
import type { FormField, PermissionGate, PermissionRequest, PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { createDefaultGate, makeGateActionTool, DEFAULT_GATE_SETTINGS_NS } from '@matatbread/matbot-default-gate';

// The seam: a privileged call site DECLARES (gate id, subject, label, fallback); the installation's
// PermissionGate DECIDES. These tests cover the two halves the harness ships — the host's boot default
// (ask, else fallback) and the default-gate plugin's policy (ask, remember, honour) — plus the binding
// that qualifies a tool's gate suffix with the name it is registered under.

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({ gate: 'plugin.add', subject: '@x/foo', label: 'Install plugin **"@x/foo"**?', fallback: false, ...over });

function recorder(answer: string): { asked: FormField[]; ask: PromptFn } {
  const asked: FormField[] = [];
  const ask = (async (f: string | FormField) => {
    if (typeof f === 'string') throw new Error('a gate always asks with a structured field');
    asked.push(f);
    return answer;
  }) as PromptFn;
  return { asked, ask };
}

// ── The host boot default ─────────────────────────────────────────────────────

test('the boot default asks through the channel in scope, as a confirm field', async () => {
  const { asked, ask } = recorder('yes');
  assert.equal(await askPermissionGate.decide(req(), ask), true);
  assert.equal(asked[0]?.type, 'confirm');
  assert.equal(asked[0]?.label, 'Install plugin **"@x/foo"**?');

  const no = recorder('no');
  assert.equal(await askPermissionGate.decide(req(), no.ask), false);
});

test('no channel means no human is reachable, and the SITE says what happens then', async () => {
  // Reproduces today's non-interactive behaviour exactly: a tool-name collision at boot overwrites,
  // everything else declines — stated once per site rather than implied at each.
  assert.equal(await askPermissionGate.decide(req({ fallback: false }), undefined), false);
  assert.equal(await askPermissionGate.decide(
    req({ gate: 'tools.overwrite', subject: 'bash', fallback: true }), undefined), true);
});

// ── ctx.gate binding ──────────────────────────────────────────────────────────

test('a tool supplies the suffix; the host qualifies it with the tool it is registered under', async () => {
  const seen: PermissionRequest[] = [];
  const gate: PermissionGate = { async decide(r) { seen.push(r); return true; } };

  // Both runtimes register a tool named `plugin`, so both reach the same gate id — which is the whole
  // reason the qualifier is the TOOL name and not the package's.
  await bindGate(gate, 'plugin', undefined).gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false });
  await bindGate(gate, 'mcp_action', undefined).gate({ gate: 'remove', subject: 'srv', label: 'l', fallback: false });

  assert.deepEqual(seen.map(r => r.gate), ['plugin.add', 'mcp_action.remove']);
});

test('with no gate registered at all, the binding still asks rather than allowing', async () => {
  const { asked, ask } = recorder('no');
  const bound = bindGate(undefined, 'plugin', ask);
  assert.equal(await bound.gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false }), false);
  assert.equal(asked.length, 1);
});

// ── The default-gate policy ───────────────────────────────────────────────────

function policy(defaults?: Record<string, unknown>, previous?: PermissionGate): {
  gate: PermissionGate; docs: Map<string, unknown>; settings: ReturnType<typeof makePluginSettings>;
} {
  installSettingsDefaults(defaults === undefined ? undefined : new Map([[DEFAULT_GATE_SETTINGS_NS, defaults]]));
  const docs = new Map<string, unknown>();
  const store = {
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, doc: unknown) => { docs.set(id, doc); },
    cas:    async (id: string, _v: string, doc: unknown) => { docs.set(id, doc); return { ok: true }; },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<SettingsDoc>;
  const settings = makePluginSettings(store, DEFAULT_GATE_SETTINGS_NS);
  return { gate: createDefaultGate(settings, previous), docs, settings };
}

afterEach(() => { installSettingsDefaults(undefined); });

test('an unknown gate id is asked about, never allowed', async () => {
  const { gate } = policy({ 'plugin.add': ['@x/foo'] });
  const { asked, ask } = recorder('Deny');
  assert.equal(await gate.decide(req({ gate: '@fnarr/jobs.run', subject: 'nightly' }), ask), false);
  assert.equal(asked.length, 1, 'a gate this build never compiled against still reaches a human');
});

test('a configured subject is allowed; a sibling subject of the same gate is not', async () => {
  const { gate } = policy({ 'plugin.add': ['@x/foo'] });
  const silent = recorder('Deny');
  assert.equal(await gate.decide(req({ subject: '@x/foo' }), silent.ask), true);
  assert.equal(silent.asked.length, 0);

  assert.equal(await gate.decide(req({ subject: 'https://evil/foo.ts' }), silent.ask), false);
  assert.equal(silent.asked.length, 1, 'the subject is the spelling the call site has, not a canonical identity');
});

test('"Always allow every <gate>" stores true, and every later subject rides on it', async () => {
  const { gate, settings } = policy();
  const every = recorder('always-gate');
  assert.equal(await gate.decide(req(), every.ask), true);
  assert.equal(await settings.get('plugin.add'), true);

  const later = recorder('Deny');
  assert.equal(await gate.decide(req({ subject: '@y/bar' }), later.ask), true);
  assert.equal(later.asked.length, 0);
});

test('a plain "Allow" permits this act and remembers NOTHING', async () => {
  // The bug this pins: the answer used to be matched by PREFIX against the rendered labels, and
  // "Allow" shares its first letter with "Always allow …" — so clicking Allow once silently wrote a
  // standing answer the user never gave, and every later add of that subject proceeded with no prompt.
  const { gate, settings } = policy();
  const once = recorder('allow');
  assert.equal(await gate.decide(req(), once.ask), true);
  assert.equal(await settings.get('plugin.add'), undefined, 'a one-off Allow persists nothing');
  assert.equal(await settings.get('__gates__'),  undefined, 'and indexes nothing');

  // So the same subject is asked about again, and a Deny is still a Deny.
  const again = recorder('Deny');
  assert.equal(await gate.decide(req(), again.ask), false);
  assert.equal(again.asked.length, 1);
});

test('an answer matching no option is a refusal, not an allow', async () => {
  const { gate } = policy();
  assert.equal(await gate.decide(req({ fallback: true }), recorder('').ask), false);
  assert.equal(await gate.decide(req(), recorder('a').ask), false, 'a bare prefix is not an answer');
});

test('echoing a rendered "Always allow …" label remembers nothing', async () => {
  // The labels are prose and nothing compares against them, so a frontend that sent one back instead
  // of the option's value cannot author a standing answer — the failure mode this whole split exists
  // to make unreachable. (It reads as "no option matched", i.e. a refusal.)
  const { gate, settings } = policy();
  assert.equal(await gate.decide(req(), recorder('Always allow "@x/foo"').ask), false);
  assert.equal(await settings.get('plugin.add'), undefined);
});

test('the options separate what is shown from what is answered', async () => {
  // Every option carries a value distinct from its label, so a reworded (or localised) label cannot
  // change what the policy stores — the identity is the token, never the prose.
  const { gate } = policy();
  const seen = recorder('deny');
  await gate.decide(req({ gate: 'plugin.add', subject: '@x/foo' }), seen.ask);

  const opts = seen.asked[0]?.options ?? [];
  assert.deepEqual(opts.map(optionValue), ['deny', 'allow', 'always-subject', 'always-gate']);
  assert.deepEqual(opts.map(optionLabel), [
    'Deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add',
  ]);
  assert.equal(seen.asked[0]?.default, 'deny', 'the default names a value, not a label');
});

test('with nobody to ask, the policy delegates to the gate it displaced', async () => {
  // Composition is the ToolCallValidator idiom: the pair composes in either load order, because the
  // displaced gate is captured rather than shadowed.
  const seen: PermissionRequest[] = [];
  const previous: PermissionGate = { async decide(r) { seen.push(r); return true; } };
  const { gate } = policy(undefined, previous);

  assert.equal(await gate.decide(req({ fallback: false }), undefined), true, 'the predecessor decides');
  assert.deepEqual(seen.map(r => r.subject), ['@x/foo']);

  // And with no predecessor it is the site's own fallback, which is what the host default answers too.
  const alone = policy();
  assert.equal(await alone.gate.decide(req({ fallback: true }), undefined), true);
  assert.equal(await alone.gate.decide(req({ fallback: false }), undefined), false);
});

// ── gate_action ───────────────────────────────────────────────────────────────

async function run<T>(tool: { executor: { execute(i: unknown, c: never): AsyncIterable<{ type: string } & Record<string, unknown>> } }, input: unknown): Promise<T> {
  for await (const ev of tool.executor.execute(input, undefined as never)) {
    if (ev.type === 'result') return ev['value'] as T;
    if (ev.type === 'error')  throw new Error(String(ev['message']));
  }
  throw new Error('no result');
}

test('gate_action get reports what is in EFFECT — stored answer and configured floor alike', async () => {
  const { gate, settings } = policy({ 'tools.overwrite': ['bash'] });
  const tool = makeGateActionTool(settings);

  const configured = await run<{ answers: { gate: string; effect: string; subjects?: string[] }[] }>(
    tool, { action: 'get', gate: 'tools.overwrite' });
  assert.deepEqual(configured.answers, [{ gate: 'tools.overwrite', effect: 'subjects', subjects: ['bash'] }]);

  // A gate nobody has answered rests at "ask", and the whole vocabulary is reportable without waiting
  // for each gate to be reached for the first time.
  const all = await run<{ answers: { gate: string; effect: string }[] }>(tool, { action: 'get' });
  assert.equal(all.answers.find(a => a.gate === 'plugin.add')?.effect, 'ask');

  // An answer given at a prompt reads the same way as one an installation configured.
  await gate.decide(req(), recorder('always-subject').ask);
  const after = await run<{ answers: { gate: string; effect: string; subjects?: string[] }[] }>(
    tool, { action: 'get', gate: 'plugin.add' });
  assert.deepEqual(after.answers, [{ gate: 'plugin.add', effect: 'subjects', subjects: ['@x/foo'] }]);
});

test('gate_action clear forgets an answer, reverting to what the installation configured', async () => {
  const { gate, settings } = policy({ 'plugin.add': ['@configured/one'] });
  const tool = makeGateActionTool(settings);

  await gate.decide(req({ subject: '@x/foo' }), recorder('always-subject').ask);
  assert.equal(await gate.decide(req({ subject: '@x/foo' }), recorder('Deny').ask), true);

  // One subject out of the stored list; the rest of the list stands.
  await run(tool, { action: 'clear', gate: 'plugin.add', subject: '@x/foo' });
  const asked = recorder('Deny');
  assert.equal(await gate.decide(req({ subject: '@x/foo' }), asked.ask), false);
  assert.equal(asked.asked.length, 1);
  assert.equal(await gate.decide(req({ subject: '@configured/one' }), asked.ask), true);

  // The whole gate: delete means "revert to the configured default", so the floor comes back.
  await gate.decide(req({ subject: '@x/foo' }), recorder('always-subject').ask);
  const cleared = await run<{ cleared: string[] }>(tool, { action: 'clear', gate: 'plugin.add' });
  assert.deepEqual(cleared.cleared, ['plugin.add']);
  assert.equal(await gate.decide(req({ subject: '@configured/one' }), asked.ask), true,
    'the installation floor is not a stored answer, so clearing cannot delete it');
});
