import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askPermissionGate, bindGate, createSession, HookRegistry, installSettingsDefaults, makePluginSettings,
         optionValue, optionLabel, permitted, refused, refusalMessage } from '@matatbread/matbot-core';
import type { FormField, PermissionGate, PermissionRequest, PromptFn, SettingsDoc, Store, Tool } from '@matatbread/matbot-core';
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
  assert.equal((await askPermissionGate.decide(req(), ask)).allowed, true);
  assert.equal(asked[0]?.type, 'confirm');
  assert.equal(asked[0]?.label, 'Install plugin **"@x/foo"**?');

  const no = recorder('no');
  assert.equal((await askPermissionGate.decide(req(), no.ask)).allowed, false);
});

test('no channel means no human is reachable, and the SITE says what happens then', async () => {
  // Reproduces today's non-interactive behaviour exactly: a tool-name collision at boot overwrites,
  // everything else declines — stated once per site rather than implied at each.
  assert.equal((await askPermissionGate.decide(req({ fallback: false }), undefined)).allowed, false);
  assert.equal((await askPermissionGate.decide(
    req({ gate: 'tools.overwrite', subject: 'bash', fallback: true }), undefined)).allowed, true);
});

// ── The source on the answer ──────────────────────────────────────────────────
// `source` names which test in the cascade produced the answer — a human, a standing answer out of
// configuration, or the site's own fallback. It exists for the REPORT, not the control flow: a refusal
// that says only "Cancelled." reads to a model as a malfunction, so it hunts for a workaround or a bug.

test('the boot default distinguishes a human answering from nobody being there', async () => {
  assert.deepEqual(await askPermissionGate.decide(req(), recorder('yes').ask), permitted('user'));
  assert.deepEqual(await askPermissionGate.decide(req(), recorder('no').ask), refused('user'),
    'a no is still the user\'s answer — the source is who decided, not what they decided');
  assert.deepEqual(await askPermissionGate.decide(req(), undefined), refused('fallback'));
  assert.deepEqual(await askPermissionGate.decide(req({ fallback: true }), undefined), permitted('fallback'));
});

test('a standing answer reports as configuration, and a prompt as the user', async () => {
  const configured = policy({ 'plugin.add': ['@x/foo'] });
  assert.deepEqual(await configured.gate.decide(req(), recorder('Deny').ask), permitted('configuration'),
    'a stored answer and an installation floor are one layer: settings reads are layered, so nothing '
    + 'here can tell them apart, and claiming `user` for a configured floor would be a lie half the time');

  const asked = policy();
  assert.deepEqual(await asked.gate.decide(req(), recorder('allow').ask), permitted('user'));
  assert.deepEqual(await asked.gate.decide(req(), recorder('deny').ask), refused('user'));
});

test('a delegated decision keeps the SOURCE of the gate that made it', async () => {
  // Rewriting it here would erase the one fact `source` carries: the layer that answered.
  const previous: PermissionGate = { async decide() { return refused('acme-directory'); } };
  const { gate } = policy(undefined, previous);
  assert.deepEqual(await gate.decide(req({ fallback: true }), undefined), refused('acme-directory'));
});

test('the refusal prose names the layer, and an unknown source is reported as itself', async () => {
  // A policy this build never compiled against has layers of its own, so the vocabulary is open.
  assert.match(refusalMessage(refused('user')), /the user declined/);
  assert.match(refusalMessage(refused('configuration')), /permission policy does not allow it/);
  assert.match(refusalMessage(refused('fallback')), /nobody could be asked/);
  assert.match(refusalMessage(refused('acme-directory')), /\(acme-directory\)/);
  // The two a model can do nothing about say so, so it stops looking for a fault to fix.
  assert.match(refusalMessage(refused('user')), /do not retry it/);
  assert.doesNotMatch(refusalMessage(refused('fallback')), /do not retry it/,
    'the one source that CAN change: it needs a human present, or a standing answer');
  // The caller's own words for the act, when it has them.
  assert.match(refusalMessage(refused('user'), 'Import of \'node:fs\''), /^Import of 'node:fs': cancelled/);
});

// ── ctx.gate binding ──────────────────────────────────────────────────────────

test('a tool supplies the suffix; the host qualifies it with the tool it is registered under', async () => {
  const seen: PermissionRequest[] = [];
  const gate: PermissionGate = { async decide(r) { seen.push(r); return permitted('user'); } };

  // Both runtimes register a tool named `plugin`, so both reach the same gate id — which is the whole
  // reason the qualifier is the TOOL name and not the package's.
  await bindGate(gate, 'plugin', undefined).gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false });
  await bindGate(gate, 'mcp_action', undefined).gate({ gate: 'remove', subject: 'srv', label: 'l', fallback: false });

  assert.deepEqual(seen.map(r => r.gate), ['plugin.add', 'mcp_action.remove']);
});

test('a namespace is honoured only for a tool the SAME plugin registered', async () => {
  const seen: PermissionRequest[] = [];
  const gate: PermissionGate = { async decide(r) { seen.push(r); return permitted('user'); } };
  const registry = new Map([
    ['tool_function', { pluginName: '@matatbread/matbot-function-tools' }],
    ['plugin',        { pluginName: '__host__' }],
  ]);
  const tools = { resolve: (n: string) => registry.get(n) ?? null };
  const req = { gate: 'import', subject: 'scrape_prices node:fs', label: 'l', fallback: false };

  // A function-tools function is registered under the name the MODEL gave it, so qualifying by that name
  // would file each definition's answers under its own gate id, where no other function reads them.
  const fn = { name: 'scrape_prices', pluginName: '@matatbread/matbot-function-tools' };
  await bindGate(gate, fn, undefined, tools).gate({ ...req, namespace: 'tool_function' });
  assert.deepEqual(seen.map(r => r.gate), ['tool_function.import']);
  assert.equal(seen[0]?.subject, 'scrape_prices node:fs', 'which function asked is still the subject');
  assert.equal('namespace' in seen[0]!, false, 'the policy sees a qualified id, not the qualifier');

  // Anyone else's namespace is refused before the policy is consulted: a plugin addresses only its own
  // gates, including core's `tools.*`, which no tool is registered as.
  const rogue = { name: 'rogue', pluginName: '@x/rogue' };
  for (const namespace of ['plugin', 'tool_function', 'tools']) {
    await assert.rejects(bindGate(gate, rogue, undefined, tools).gate({ ...req, namespace }), /same plugin/, namespace);
  }
  // Nothing to check against is not a pass.
  await assert.rejects(bindGate(gate, 'scrape_prices', undefined, tools).gate({ ...req, namespace: 'tool_function' }), /same plugin/);
  await assert.rejects(bindGate(gate, fn, undefined).gate({ ...req, namespace: 'tool_function' }), /same plugin/);
  // Naming itself needs no check.
  await bindGate(gate, rogue, undefined).gate({ ...req, namespace: 'rogue' });
  assert.deepEqual(seen.map(r => r.gate), ['tool_function.import', 'rogue.import']);
});

test('a turn tool belongs to the plugin whose screen hook offered it, whatever it claims', async () => {
  const hooks = new HookRegistry();
  const tool = (name: string, pluginName?: string): Tool => ({
    name, description: '', inputSchema: { type: 'object' }, executor: { async *execute() {} },
    ...(pluginName !== undefined ? { pluginName } : {}),
  });
  hooks.register({ on: 'screen', pluginName: '@x/rogue', handler: () => ({ tools: () => [tool('a', '@matatbread/matbot-function-tools')] }) });
  hooks.register({ on: 'screen', handler: () => ({ tools: async () => [tool('b', '@x/claimed')] }) });
  const signal = new AbortController().signal;
  const session = createSession();
  const screen = await hooks.runScreen({ session, config: {} as never, signal, prompt: (() => Promise.resolve('')) as never });
  const offered = (await Promise.all(screen.tools.map(src => src(session)))).flat();
  assert.deepEqual(offered.map(t => [t.name, t.pluginName]), [['a', '@x/rogue'], ['b', undefined]]);
});

test('with no gate registered at all, the binding still asks rather than allowing', async () => {
  const { asked, ask } = recorder('no');
  const bound = bindGate(undefined, 'plugin', ask);
  assert.deepEqual(await bound.gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false }),
    refused('user'));
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

// ── Suggested generalisations ─────────────────────────────────────────────────
// A two-dimensional decision (which function, which module) cannot be keyed on the subject alone — a
// brand-new function would inherit every grant a reviewed one earned. The call site enumerates how its
// own subjects generalise and the policy does set membership over strings it never parses, so no gate id
// is hardcoded here and a gate this build never compiled against generalises the same way.

const importReq = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  gate: 'tool_function.import', subject: 'probe node:os',
  label: 'Allow function "probe" to import **node:os**?', fallback: false,
  standing: [
    { subject: 'probe node:os', label: 'Always allow function "probe" to import node:os' },
    { subject: 'probe node:',   label: 'Always allow function "probe" to import any node builtin' },
    { subject: '* node:os',     label: 'Always allow ANY function to import node:os' },
  ], ...over,
});

test('a stored generalisation covers a subject it was never written for', async () => {
  const { gate } = policy({ 'tool_function.import': ['probe node:'] });
  // Nobody stored "probe node:os", and nobody is asked: the suggestion matched.
  const { asked } = recorder('deny');
  assert.equal((await gate.decide(importReq(), asked.length === 0 ? undefined : undefined)).allowed, true);
  // A different function is NOT covered by the first one's standing answer.
  assert.equal((await gate.decide(importReq({ subject: 'other node:os', standing: [
    { subject: 'other node:', label: 'x' }, { subject: '* node:os', label: 'y' }] }), undefined)).allowed, false);
});

test('each standing answer is offered in order, labelled by the CALL SITE, and the chosen one is stored', async () => {
  const { gate, settings } = policy();
  const { asked, ask } = recorder('always-1');
  assert.equal((await gate.decide(importReq(), ask)).allowed, true);
  // The policy renders the call site's prose and never rewrites it — the same rule `label` follows.
  // Rendering `Always allow "<subject>"` could only ever show the key, which is what made the prompt
  // unreadable: nothing outside the call site knows that `node:` means "any builtin".
  assert.deepEqual(asked[0]?.options?.map(optionLabel), [
    'Deny', 'Allow',
    'Always allow function "probe" to import node:os',
    'Always allow function "probe" to import any node builtin',
    'Always allow ANY function to import node:os',
    'Always allow every tool_function.import',
  ]);
  assert.deepEqual(await settings.get('tool_function.import'), ['probe node:']);
});

test('with none offered, the policy still offers the exact subject', async () => {
  // A gate whose subject is already prose a human recognises (`@x/foo`) needs nothing more, and naming
  // the subject is all a policy can honestly do.
  const { gate, settings } = policy();
  const { asked, ask } = recorder('always-0');
  assert.equal((await gate.decide(req(), ask)).allowed, true);
  assert.deepEqual(asked[0]?.options?.map(optionLabel),
    ['Deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add']);
  assert.deepEqual(await settings.get('plugin.add'), ['@x/foo']);
});

test('a policy stores only a subject it actually offered', async () => {
  // The remembered value is looked up among the rendered options, never taken from the answer text —
  // otherwise a call site could widen any gate's memory by what it puts in one field.
  const { gate, docs } = policy();
  const { ask } = recorder('always-9');
  assert.equal((await gate.decide(importReq(), ask)).allowed, false, 'an unrecognised answer grants nothing');
  assert.equal(docs.size, 0);
});

test('an unknown gate id is asked about, never allowed', async () => {
  const { gate } = policy({ 'plugin.add': ['@x/foo'] });
  const { asked, ask } = recorder('Deny');
  assert.equal((await gate.decide(req({ gate: '@fnarr/jobs.run', subject: 'nightly' }), ask)).allowed, false);
  assert.equal(asked.length, 1, 'a gate this build never compiled against still reaches a human');
});

test('a configured subject is allowed; a sibling subject of the same gate is not', async () => {
  const { gate } = policy({ 'plugin.add': ['@x/foo'] });
  const silent = recorder('Deny');
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), silent.ask)).allowed, true);
  assert.equal(silent.asked.length, 0);

  assert.equal((await gate.decide(req({ subject: 'https://evil/foo.ts' }), silent.ask)).allowed, false);
  assert.equal(silent.asked.length, 1, 'the subject is the spelling the call site has, not a canonical identity');
});

test('"Always allow every <gate>" stores true, and every later subject rides on it', async () => {
  const { gate, settings } = policy();
  const every = recorder('always-gate');
  assert.equal((await gate.decide(req(), every.ask)).allowed, true);
  assert.equal(await settings.get('plugin.add'), true);

  const later = recorder('Deny');
  assert.equal((await gate.decide(req({ subject: '@y/bar' }), later.ask)).allowed, true);
  assert.equal(later.asked.length, 0);
});

test('a plain "Allow" permits this act and remembers NOTHING', async () => {
  // The bug this pins: the answer used to be matched by PREFIX against the rendered labels, and
  // "Allow" shares its first letter with "Always allow …" — so clicking Allow once silently wrote a
  // standing answer the user never gave, and every later add of that subject proceeded with no prompt.
  const { gate, settings } = policy();
  const once = recorder('allow');
  assert.equal((await gate.decide(req(), once.ask)).allowed, true);
  assert.deepEqual(await settings.entries(), {}, 'a one-off Allow persists nothing at all');

  // So the same subject is asked about again, and a Deny is still a Deny.
  const again = recorder('Deny');
  assert.equal((await gate.decide(req(), again.ask)).allowed, false);
  assert.equal(again.asked.length, 1);
});

test('an answer matching no option is a refusal, not an allow', async () => {
  const { gate } = policy();
  assert.equal((await gate.decide(req({ fallback: true }), recorder('').ask)).allowed, false);
  assert.equal((await gate.decide(req(), recorder('a').ask)).allowed, false, 'a bare prefix is not an answer');
});

test('echoing a rendered "Always allow …" label remembers nothing', async () => {
  // The labels are prose and nothing compares against them, so a frontend that sent one back instead
  // of the option's value cannot author a standing answer — the failure mode this whole split exists
  // to make unreachable. (It reads as "no option matched", i.e. a refusal.)
  const { gate, settings } = policy();
  assert.equal((await gate.decide(req(), recorder('Always allow "@x/foo"').ask)).allowed, false);
  assert.equal(await settings.get('plugin.add'), undefined);
});

test('the options separate what is shown from what is answered', async () => {
  // Every option carries a value distinct from its label, so a reworded (or localised) label cannot
  // change what the policy stores — the identity is the token, never the prose.
  const { gate } = policy();
  const seen = recorder('deny');
  await gate.decide(req({ gate: 'plugin.add', subject: '@x/foo' }), seen.ask);

  const opts = seen.asked[0]?.options ?? [];
  assert.deepEqual(opts.map(optionValue), ['deny', 'allow', 'always-0', 'always-gate']);
  assert.deepEqual(opts.map(optionLabel), [
    'Deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add',
  ]);
  assert.equal(seen.asked[0]?.default, 'deny', 'the default names a value, not a label');
});

test('with nobody to ask, the policy delegates to the gate it displaced', async () => {
  // Composition is the ToolCallValidator idiom: the pair composes in either load order, because the
  // displaced gate is captured rather than shadowed.
  const seen: PermissionRequest[] = [];
  const previous: PermissionGate = { async decide(r) { seen.push(r); return permitted('user'); } };
  const { gate } = policy(undefined, previous);

  assert.equal((await gate.decide(req({ fallback: false }), undefined)).allowed, true, 'the predecessor decides');
  assert.deepEqual(seen.map(r => r.subject), ['@x/foo']);

  // And with no predecessor it is the site's own fallback, which is what the host default answers too.
  const alone = policy();
  assert.equal((await alone.gate.decide(req({ fallback: true }), undefined)).allowed, true);
  assert.equal((await alone.gate.decide(req({ fallback: false }), undefined)).allowed, false);
});

// ── Composition against a host-shaped registry ────────────────────────────────

/**
 * The two lines every host writes for this key: a mutable current impl, and a MEMBER that reads it.
 * A getter, deliberately not `forwardingProxy` — which is what every other swap-member uses, and what
 * this one must not, because the documented way to replace a policy is to capture the one you displace
 * and delegate to it. Through a capture-safe proxy that capture resolves to whatever is current, which
 * one line later is the capturing gate itself: it calls itself until the stack overflows, and the
 * recommended pattern is the pattern that breaks. Mirrors apps/cli and apps/web-bundle.
 */
function hostRegistry(boot: PermissionGate) {
  let active = boot;
  return {
    get PermissionGate(): PermissionGate { return active; },
    register:   (gate: PermissionGate) => { active = gate; },
    unregister: () => { active = boot; },
  };
}

test('a policy that displaces another can delegate to it', async () => {
  const asked: string[] = [];
  const boot: PermissionGate = { async decide(r) { asked.push(`boot:${r.gate}`); return r.fallback ? permitted('fallback') : refused('fallback'); } };
  const host = hostRegistry(boot);

  // Exactly what a policy plugin's setup() does, and what the docblock tells it to do.
  const previous = host.PermissionGate;
  host.register({
    async decide(r, ask) {
      if (r.gate === 'plugin.add') return refused('configuration');
      return previous.decide(r, ask);        // must reach `boot`, not recurse into this gate
    },
  });

  assert.equal((await host.PermissionGate.decide(req(), undefined)).allowed, false);
  assert.equal((await host.PermissionGate.decide(req({ gate: 'tools.overwrite', fallback: true }), undefined)).allowed, true);
  assert.deepEqual(asked, ['boot:tools.overwrite'], 'the displaced gate decided, exactly once');

  // And unloading the policy reverts to the host's boot default rather than dangling on the gone impl.
  host.unregister();
  assert.equal((await host.PermissionGate.decide(req({ gate: 'plugin.add', fallback: true }), undefined)).allowed, true);
});

test('the shipped policy delegates without recursing when it displaces a live one', async () => {
  // The same shape with the real policy in the middle: createDefaultGate(settings, previous) is the
  // documented composition, and `previous` here is captured from the registry the way a plugin does.
  const host = hostRegistry({ async decide() { return permitted('user'); } });
  const { settings } = policy();
  host.register(createDefaultGate(settings, host.PermissionGate));

  // No channel, nothing stored: the policy defers, and the deferral must terminate.
  assert.equal((await host.PermissionGate.decide(req({ fallback: false }), undefined)).allowed, true);
});

test('two "Always allow" answers at once keep both subjects', async () => {
  // Appending a subject is a read-modify-write and PluginSettings has no CAS on the value, so the two
  // writes must be serialised: unguarded, both read the same list and the second drops the first.
  const { gate, settings } = policy();
  await Promise.all([
    gate.decide(req({ subject: '@x/foo' }), recorder('always-0').ask),
    gate.decide(req({ subject: '@y/bar' }), recorder('always-0').ask),
  ]);
  assert.deepEqual((await settings.get<string[]>('plugin.add'))?.slice().sort(), ['@x/foo', '@y/bar']);
});

// ── gate_action ───────────────────────────────────────────────────────────────

async function run<T>(tool: { executor: { execute(i: unknown, c: never): AsyncIterable<{ type: string } & Record<string, unknown>> } }, input: unknown): Promise<T> {
  for await (const ev of tool.executor.execute(input, undefined as never)) {
    if (ev.type === 'result') return ev['value'] as T;
    if (ev.type === 'error')  throw new Error(String(ev['message']));
  }
  throw new Error('no result');
}

test('gate_action get reports ANSWERS — never a default it cannot know', async () => {
  // Nothing configured and nothing answered: the listing is empty. An absent key says only "no answer
  // recorded" — what a gate does then is the call site's `fallback` and whatever policy is registered,
  // neither of which this tool can know, so there is no row to write. Gate ids are open anyway, so a
  // built-in vocabulary would be both stale and incomplete.
  const bare = policy();
  assert.deepEqual((await run<{ answers: unknown[] }>(makeGateActionTool(bare.settings), { action: 'get' })).answers, []);

  // An answer an installation SHIPPED is in force, so it is listed — the enumeration is the settings
  // namespace itself (stored over the configured floor), not a record of what this code happened to
  // write, which is exactly the answer the old index could never see.
  const { gate, settings } = policy({ 'tools.overwrite': ['bash'] });
  const tool = makeGateActionTool(settings);
  const configured = await run<{ answers: { gate: string; effect: string; subjects?: string[] }[] }>(
    tool, { action: 'get' });
  assert.deepEqual(configured.answers, [{ gate: 'tools.overwrite', effect: 'subjects', subjects: ['bash'] }]);

  // An answer given at a prompt reads the same way as one an installation configured, and joins it.
  await gate.decide(req(), recorder('always-0').ask);
  const after = await run<{ answers: { gate: string; effect: string; subjects?: string[] }[] }>(
    tool, { action: 'get', gate: 'plugin.add' });
  assert.deepEqual(after.answers, [{ gate: 'plugin.add', effect: 'subjects', subjects: ['@x/foo'] }]);

  const listed = await run<{ answers: { gate: string }[] }>(tool, { action: 'get' });
  assert.deepEqual(listed.answers.map(a => a.gate).sort(), ['plugin.add', 'tools.overwrite']);
});

test('a key that is not a standing answer is never reported as one', async () => {
  // The namespace is enumerated, so anything living in it is seen — and only values this policy can
  // read as an answer are reported. A permission tool must not turn a stray key into a permission.
  const { settings } = policy({ 'plugin.add': 'nonsense' });
  await settings.set('some-other-setting', 42);
  const got = await run<{ answers: unknown[] }>(makeGateActionTool(settings), { action: 'get' });
  assert.deepEqual(got.answers, []);
});

test('gate_action clear forgets an answer, reverting to what the installation configured', async () => {
  const { gate, settings } = policy({ 'plugin.add': ['@configured/one'] });
  const tool = makeGateActionTool(settings);

  await gate.decide(req({ subject: '@x/foo' }), recorder('always-0').ask);
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), recorder('Deny').ask)).allowed, true);

  // One subject out of the stored list; the rest of the list stands.
  await run(tool, { action: 'clear', gate: 'plugin.add', subject: '@x/foo' });
  const asked = recorder('Deny');
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), asked.ask)).allowed, false);
  assert.equal(asked.asked.length, 1);
  assert.equal((await gate.decide(req({ subject: '@configured/one' }), asked.ask)).allowed, true);

  // The whole gate: delete means "revert to the configured default", so the floor comes back.
  await gate.decide(req({ subject: '@x/foo' }), recorder('always-0').ask);
  const cleared = await run<{ cleared: string[]; message: string }>(tool, { action: 'clear', gate: 'plugin.add' });
  assert.deepEqual(cleared.cleared, ['plugin.add']);
  assert.equal((await gate.decide(req({ subject: '@configured/one' }), asked.ask)).allowed, true,
    'the installation floor is not a stored answer, so clearing cannot delete it');
  assert.match(cleared.message, /configured defaults/,
    'and the result says so, since the gate is still allowed for what config named');
});

test('clear does not claim to have cleared a configured default', async () => {
  // `delete` reverts to the configured default, so for a gate answered ONLY in default_settings there
  // is nothing stored to remove and nothing changes. Listing it as cleared was a success report for a
  // no-op — the one thing a permissions tool must not do.
  const { settings } = policy({ 'tools.overwrite': ['bash'] });
  const tool = makeGateActionTool(settings);

  const result = await run<{ cleared: string[]; message: string }>(tool, { action: 'clear' });
  assert.deepEqual(result.cleared, [], 'nothing was cleared, because nothing was stored');
  assert.match(result.message, /configured defaults/);
  assert.match(result.message, /tools\.overwrite/, 'and it names what is still in force');

  // Still in effect afterwards — the report and the behaviour agree.
  const still = await run<{ answers: { gate: string }[] }>(tool, { action: 'get' });
  assert.deepEqual(still.answers.map(a => a.gate), ['tools.overwrite']);
});
