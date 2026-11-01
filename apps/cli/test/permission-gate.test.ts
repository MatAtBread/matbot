import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_NO, askPermissionGate, bindGate, createSession, HookRegistry, installSettingsDefaults, makePluginSettings,
         optionValue, optionLabel, permitted, refused, refusalMessage, slugSettingsNamespace, HTTP_TOOL_SESSION,
         installPrincipalCarrier, runAs } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import type { FormField, PermissionContext, PermissionGate, PermissionRequest, PromptFn, SettingsDoc, Store, Tool } from '@matatbread/matbot-core';
import { createDefaultGate, makeGateActionTool, DEFAULT_GATE_SETTINGS_NS } from '@matatbread/matbot-core';

// No session: a plugin's registration, a hand-assembled call — the context the gate is handed when there is none.
const NOWHERE: PermissionContext = {};

// Session answers held in memory are keyed by principal, so two principals can be told apart.
installPrincipalCarrier(createAlsPrincipalCarrier());

// The seam: a privileged call site DECLARES (gate id, subject, label, fallback); the installation's
// PermissionGate DECIDES. These tests cover the two halves the harness ships — the bare asking gate
// (ask, else fallback) and core's default policy (ask, remember, honour) — plus the binding
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
  assert.equal((await askPermissionGate.decide(req(), ask, NOWHERE)).allowed, true);
  assert.equal(asked[0]?.type, 'confirm');
  assert.equal(asked[0]?.label, 'Install plugin **"@x/foo"**?');

  const no = recorder('no');
  assert.equal((await askPermissionGate.decide(req(), no.ask, NOWHERE)).allowed, false);
});

test('no channel means no human is reachable, and the SITE says what happens then', async () => {
  // Reproduces today's non-interactive behaviour exactly: a tool-name collision at boot overwrites,
  // everything else declines — stated once per site rather than implied at each.
  assert.equal((await askPermissionGate.decide(req({ fallback: false }), undefined, NOWHERE)).allowed, false);
  assert.equal((await askPermissionGate.decide(
    req({ gate: 'tools.overwrite', subject: 'bash', fallback: true }), undefined, NOWHERE)).allowed, true);
});

// ── The source on the answer ──────────────────────────────────────────────────
// `source` names which test in the cascade produced the answer — a human, a standing answer out of
// configuration, or the site's own fallback. It exists for the REPORT, not the control flow: a refusal
// that says only "Cancelled." reads to a model as a malfunction, so it hunts for a workaround or a bug.

test('a refusal with nobody to ask is logged for someone to act on, once per gate and subject', async () => {
  // A background job or a trigger has no human behind it, and the model is the only one told it was
  // refused. The log is the record a person sees.
  const logged: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => { logged.push(String(m)); };
  try {
    const { gate } = bindGate(undefined, 'unattended_probe', undefined, NOWHERE);
    await gate({ gate: 'connect', subject: 'https://a.example', label: 'x', fallback: false });
    await gate({ gate: 'connect', subject: 'https://a.example', label: 'x', fallback: false });
    await gate({ gate: 'connect', subject: 'https://b.example', label: 'x', fallback: false });
    await gate({ gate: 'connect', subject: 'https://c.example', label: 'x', fallback: true });   // allowed: nothing to report
    // A human who said no is not a fault to fix.
    const refusing = bindGate(undefined, 'unattended_probe', (async () => CONFIRM_NO) as PromptFn, NOWHERE);
    await refusing.gate({ gate: 'connect', subject: 'https://d.example', label: 'x', fallback: false });
  } finally { console.error = orig; }
  assert.equal(logged.length, 2, logged.join('\n'));
  assert.match(logged[0]!, /Refused unattended_probe\.connect for "https:\/\/a\.example" \(tool unattended_probe\): nobody was there to ask/);
  assert.match(logged[1]!, /"https:\/\/b\.example"/);
});

test('the boot default distinguishes a human answering from nobody being there', async () => {
  assert.deepEqual(await askPermissionGate.decide(req(), recorder('yes').ask, NOWHERE), permitted('user'));
  assert.deepEqual(await askPermissionGate.decide(req(), recorder('no').ask, NOWHERE), refused('user'),
    'a no is still the user\'s answer — the source is who decided, not what they decided');
  assert.deepEqual(await askPermissionGate.decide(req(), undefined, NOWHERE), refused('fallback'));
  assert.deepEqual(await askPermissionGate.decide(req({ fallback: true }), undefined, NOWHERE), permitted('fallback'));
});

test('a standing answer reports as configuration, and a prompt as the user', async () => {
  const configured = policy({ 'plugin.add': { '*': ['@x/foo'] } });
  assert.deepEqual(await configured.gate.decide(req(), recorder('0|once|deny').ask, NOWHERE), permitted('configuration'),
    'a stored answer and an installation floor are one layer: settings reads are layered, so nothing '
    + 'here can tell them apart, and claiming `user` for a configured floor would be a lie half the time');

  const asked = policy();
  assert.deepEqual(await asked.gate.decide(req(), recorder('0|once|allow').ask, NOWHERE), permitted('user'));
  assert.deepEqual(await asked.gate.decide(req(), recorder('0|once|deny').ask, NOWHERE), refused('user'));
});

test('a delegated decision keeps the SOURCE of the gate that made it', async () => {
  // Rewriting it here would erase the one fact `source` carries: the layer that answered.
  const previous: PermissionGate = { async decide() { return refused('acme-directory'); } };
  const { gate } = policy(undefined, previous);
  assert.deepEqual(await gate.decide(req({ fallback: true }), undefined, NOWHERE), refused('acme-directory'));
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
  await bindGate(gate, 'plugin', undefined, NOWHERE).gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false });
  await bindGate(gate, 'mcp_action', undefined, NOWHERE).gate({ gate: 'remove', subject: 'srv', label: 'l', fallback: false });

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
  await bindGate(gate, fn, undefined, NOWHERE, tools).gate({ ...req, namespace: 'tool_function' });
  assert.deepEqual(seen.map(r => r.gate), ['tool_function.import']);
  assert.equal(seen[0]?.subject, 'scrape_prices node:fs', 'which function asked is still the subject');
  assert.equal('namespace' in seen[0]!, false, 'the policy sees a qualified id, not the qualifier');

  // Anyone else's namespace is refused before the policy is consulted: a plugin addresses only its own
  // gates, including core's `tools.*`, which no tool is registered as.
  const rogue = { name: 'rogue', pluginName: '@x/rogue' };
  for (const namespace of ['plugin', 'tool_function', 'tools']) {
    await assert.rejects(bindGate(gate, rogue, undefined, NOWHERE, tools).gate({ ...req, namespace }), /same plugin/, namespace);
  }
  // Nothing to check against is not a pass.
  await assert.rejects(bindGate(gate, 'scrape_prices', undefined, NOWHERE, tools).gate({ ...req, namespace: 'tool_function' }), /same plugin/);
  await assert.rejects(bindGate(gate, fn, undefined, NOWHERE).gate({ ...req, namespace: 'tool_function' }), /same plugin/);
  // Naming itself needs no check.
  await bindGate(gate, rogue, undefined, NOWHERE).gate({ ...req, namespace: 'rogue' });
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
  const bound = bindGate(undefined, 'plugin', ask, NOWHERE);
  assert.deepEqual(await bound.gate({ gate: 'add', subject: '@x/foo', label: 'l', fallback: false }),
    refused('user'));
  assert.equal(asked.length, 1);
});

// ── The default-gate policy ───────────────────────────────────────────────────

function policy(defaults?: Record<string, unknown>, previous?: PermissionGate, stored?: Record<string, unknown>): {
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
  const id = slugSettingsNamespace(DEFAULT_GATE_SETTINGS_NS);
  if (stored !== undefined) docs.set(id, { id, version: 'v0', data: stored });
  const settings = makePluginSettings(store, DEFAULT_GATE_SETTINGS_NS);
  // The stored document alone, as the host hands it over — what the migration reads.
  const raw = async (): Promise<Record<string, unknown>> => (docs.get(id) as SettingsDoc | undefined)?.data ?? {};
  return { gate: createDefaultGate(settings, previous, raw), docs, settings };
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
    { subject: 'probe node:os', label: 'function "probe" to import node:os' },
    { subject: 'probe node:',   label: 'function "probe" to import any node builtin' },
    { subject: '* node:os',     label: 'ANY function to import node:os' },
  ], ...over,
});

test('a stored generalisation covers a subject it was never written for', async () => {
  const { gate } = policy({ 'tool_function.import': { '*': ['probe node:'] } });
  // Nobody stored "probe node:os", and nobody is asked: the suggestion matched.
  const { asked } = recorder('0|once|deny');
  assert.equal((await gate.decide(importReq(), asked.length === 0 ? undefined : undefined, NOWHERE)).allowed, true);
  // A different function is NOT covered by the first one's standing answer.
  assert.equal((await gate.decide(importReq({ subject: 'other node:os', standing: [
    { subject: 'other node:', label: 'x' }, { subject: '* node:os', label: 'y' }] }), undefined, NOWHERE)).allowed, false);
});

test('each standing answer is offered in order, labelled by the CALL SITE, and the chosen one is stored', async () => {
  const { gate, settings } = policy();
  const { asked, ask } = recorder('1|always|allow');
  assert.equal((await gate.decide(importReq(), ask, NOWHERE)).allowed, true);
  // The policy renders the call site's prose and never rewrites it — the same rule `label` follows.
  // Rendering `Always allow "<subject>"` could only ever show the key, which is what made the prompt
  // unreadable: nothing outside the call site knows that `node:` means "any builtin".
  assert.deepEqual(asked[0]?.options?.map(optionLabel), [
    'Deny', 'Always deny', 'Allow',
    'Always allow function "probe" to import node:os',
    'Always allow function "probe" to import any node builtin',
    'Always allow ANY function to import node:os',
    'Always allow every tool_function.import',
  ]);
  assert.deepEqual(await settings.get('tool_function.import'), { '*': ['probe node:'] });
});

test('with none offered, the policy still offers the exact subject', async () => {
  // A gate whose subject is already prose a human recognises (`@x/foo`) needs nothing more, and naming
  // the subject is all a policy can honestly do.
  const { gate, settings } = policy();
  const { asked, ask } = recorder('0|always|allow');
  assert.equal((await gate.decide(req(), ask, NOWHERE)).allowed, true);
  assert.deepEqual(asked[0]?.options?.map(optionLabel),
    ['Deny', 'Always deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add']);
  assert.deepEqual(await settings.get('plugin.add'), { '*': ['@x/foo'] });
});

test('a policy stores only a subject it actually offered', async () => {
  // The remembered value is looked up among the rendered options, never taken from the answer text —
  // otherwise a call site could widen any gate's memory by what it puts in one field.
  const { gate, docs } = policy();
  const { ask } = recorder('9|always|allow');
  assert.equal((await gate.decide(importReq(), ask, NOWHERE)).allowed, false, 'an unrecognised answer grants nothing');
  assert.equal(docs.size, 0);
});

test('an unknown gate id is asked about, never allowed', async () => {
  const { gate } = policy({ 'plugin.add': { '*': ['@x/foo'] } });
  const { asked, ask } = recorder('0|once|deny');
  assert.equal((await gate.decide(req({ gate: '@fnarr/jobs.run', subject: 'nightly' }), ask, NOWHERE)).allowed, false);
  assert.equal(asked.length, 1, 'a gate this build never compiled against still reaches a human');
});

test('a configured subject is allowed; a sibling subject of the same gate is not', async () => {
  const { gate } = policy({ 'plugin.add': { '*': ['@x/foo'] } });
  const silent = recorder('0|once|deny');
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), silent.ask, NOWHERE)).allowed, true);
  assert.equal(silent.asked.length, 0);

  assert.equal((await gate.decide(req({ subject: 'https://evil/foo.ts' }), silent.ask, NOWHERE)).allowed, false);
  assert.equal(silent.asked.length, 1, 'the subject is the spelling the call site has, not a canonical identity');
});

test('"Always allow every <gate>" stores true, and every later subject rides on it', async () => {
  const { gate, settings } = policy();
  const every = recorder('every|always|allow');
  assert.equal((await gate.decide(req(), every.ask, NOWHERE)).allowed, true);
  assert.deepEqual(await settings.get('plugin.add'), { '*': true });

  const later = recorder('0|once|deny');
  assert.equal((await gate.decide(req({ subject: '@y/bar' }), later.ask, NOWHERE)).allowed, true);
  assert.equal(later.asked.length, 0);
});

test('a plain "Allow" permits this act and remembers NOTHING', async () => {
  // The bug this pins: the answer used to be matched by PREFIX against the rendered labels, and
  // "Allow" shares its first letter with "Always allow …" — so clicking Allow once silently wrote a
  // standing answer the user never gave, and every later add of that subject proceeded with no prompt.
  const { gate, settings } = policy();
  const once = recorder('0|once|allow');
  assert.equal((await gate.decide(req(), once.ask, NOWHERE)).allowed, true);
  assert.deepEqual(await settings.entries(), {}, 'a one-off Allow persists nothing at all');

  // So the same subject is asked about again, and a Deny is still a Deny.
  const again = recorder('0|once|deny');
  assert.equal((await gate.decide(req(), again.ask, NOWHERE)).allowed, false);
  assert.equal(again.asked.length, 1);
});

test('an answer matching no option is a refusal, not an allow', async () => {
  const { gate } = policy();
  assert.equal((await gate.decide(req({ fallback: true }), recorder('').ask, NOWHERE)).allowed, false);
  assert.equal((await gate.decide(req(), recorder('a').ask, NOWHERE)).allowed, false, 'a bare prefix is not an answer');
});

test('echoing a rendered "Always allow …" label remembers nothing', async () => {
  // The labels are prose and nothing compares against them, so a frontend that sent one back instead
  // of the option's value cannot author a standing answer — the failure mode this whole split exists
  // to make unreachable. (It reads as "no option matched", i.e. a refusal.)
  const { gate, settings } = policy();
  assert.equal((await gate.decide(req(), recorder('Always allow "@x/foo"').ask, NOWHERE)).allowed, false);
  assert.equal(await settings.get('plugin.add'), undefined);
});

test('the options separate what is shown from what is answered', async () => {
  // Every option carries a value distinct from its label, so a reworded (or localised) label cannot
  // change what the policy stores — the identity is the token, never the prose.
  const { gate } = policy();
  const seen = recorder('0|once|deny');
  await gate.decide(req({ gate: 'plugin.add', subject: '@x/foo' }), seen.ask, NOWHERE);

  const opts = seen.asked[0]?.options ?? [];
  assert.deepEqual(opts.map(optionValue), ['0|once|deny', '0|always|deny', '0|once|allow', '0|always|allow', 'every|always|allow']);
  assert.deepEqual(opts.map(optionLabel), [
    'Deny', 'Always deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add',
  ]);
  assert.equal(seen.asked[0]?.default, '0|once|deny', 'the default names a value, not a label');
});

// ── Always deny ───────────────────────────────────────────────────────────────
// One button, for the act being asked about and nothing broader: what a model keeps requesting, refused
// from then on without asking. Stored beside the allows under a key no gate id can have, so the allow
// keys keep their format and a reader that predates denials misreads nothing.

test('"Always deny" stores the exact subject, and the act is refused unasked from then on', async () => {
  const { gate, settings } = policy();
  const first = recorder('0|always|deny');
  const d = await gate.decide(importReq(), first.ask, NOWHERE);
  assert.deepEqual([d.allowed, d.source], [false, 'user']);
  assert.deepEqual(await settings.get('deny:tool_function.import'), { '*': ['probe node:os'] }, 'the exact subject, not a broader one');
  assert.equal(await settings.get('tool_function.import'), undefined, 'no allow written');

  const again = recorder('0|once|allow');
  const d2 = await gate.decide(importReq(), again.ask, NOWHERE);
  assert.deepEqual([d2.allowed, d2.source], [false, 'configuration'], 'refused as decided in advance');
  assert.equal(again.asked.length, 0, 'and nobody is asked');
  // At a door with nobody to ask, too.
  assert.equal((await gate.decide(importReq(), undefined, NOWHERE)).source, 'configuration');
  // Only that subject: another function importing the same module is still asked.
  const other = recorder('0|once|allow');
  assert.equal((await gate.decide(importReq({ subject: 'other node:os', standing: [] }), other.ask, NOWHERE)).allowed, true);
  assert.equal(other.asked.length, 1);
});

test('a denial wins over a broader allow given after it', async () => {
  const { gate } = policy({ 'deny:tool_function.import': { '*': ['probe node:os'] }, 'tool_function.import': { '*': ['* node:os'] } });
  const seen = recorder('0|once|allow');
  assert.equal((await gate.decide(importReq(), seen.ask, NOWHERE)).allowed, false);
  assert.equal((await gate.decide(importReq({ subject: 'other node:os', standing: [{ subject: '* node:os', label: 'x' }] }), seen.ask, NOWHERE)).allowed, true,
               'everyone else still gets the allow');
  assert.equal(seen.asked.length, 0);
});

test('an installation can configure a denial for every subject of a gate', async () => {
  const { gate } = policy({ 'deny:plugin.add': { '*': true } });
  const seen = recorder('0|once|allow');
  assert.equal((await gate.decide(req({ gate: 'plugin.add', subject: '@x/foo' }), seen.ask, NOWHERE)).allowed, false);
  assert.equal(seen.asked.length, 0);
});

test('a configured denial may name any standing subject the call site offers, as an allow may', async () => {
  // "No function may import any builtin" for one function, and "no function may import node:os" for all —
  // the shapes a directory deny for a path takes (`* /home/me/.ssh/`).
  const { gate } = policy({ 'deny:tool_function.import': { '*': ['probe node:', '* node:os'] } });
  const seen = recorder('0|once|allow');
  assert.deepEqual(await gate.decide(importReq(), seen.ask, NOWHERE), refused('configuration'));
  assert.deepEqual(await gate.decide(importReq({ subject: 'other node:os', standing: [{ subject: '* node:os', label: 'x' }] }), seen.ask, NOWHERE),
                   refused('configuration'), 'the every-function form covers another function');
  assert.equal(seen.asked.length, 0);
});

test('a declared hierarchy lets a stored subject ending at the boundary cover what lies beneath it', async () => {
  const fsReq = (subject: string, dir: string, sep?: string): PermissionRequest => ({
    gate: 'tool_function.fs-read', subject, label: 'l', fallback: false,
    standing: [{ subject, label: 'x' }, { subject: `* ${dir}`, label: 'y' }],
    ...(sep !== undefined ? { separators: [sep] } : {}),
  });
  const { gate } = policy({ 'tool_function.fs-read': { '*': ['* /home/me/', 'f /x/notes.txt'] } });
  const snap = await gate.snapshot(NOWHERE);
  assert.deepEqual(snap(fsReq('f /home/me/a/b/c.txt', '/home/me/a/b/', '/')), permitted('configuration'), 'deep under the grant');
  assert.deepEqual(snap(fsReq('f /home/me/a/b/c.txt', '/home/me/a/b/')), refused('fallback'), 'no hierarchy declared: exact only');
  assert.deepEqual(snap(fsReq('f /home/mexico/z.txt', '/home/mexico/', '/')), refused('fallback'), 'a prefix stops at the boundary');
  assert.deepEqual(snap(fsReq('f /x/notes.txt.bak', '/x/', '/')), refused('fallback'),
                   'a stored subject not ending at the boundary matches only exactly');
  const denied = policy({ 'tool_function.fs-read': { '*': ['* /home/me/'] }, 'deny:tool_function.fs-read': { '*': ['* /home/me/.ssh/'] } });
  const seen = recorder('0|once|allow');
  assert.deepEqual(await denied.gate.decide(fsReq('f /home/me/.ssh/keys/id', '/home/me/.ssh/keys/', '/'), seen.ask, NOWHERE), refused('configuration'));
  assert.deepEqual(await denied.gate.decide(fsReq('f /home/me/notes', '/home/me/', '/'), seen.ask, NOWHERE), permitted('configuration'));
  assert.equal(seen.asked.length, 0);
});

test('module specifiers nest at : and /, so a configured every-function, every-builtin answer applies', async () => {
  const imp = (subject: string, spec: string): PermissionRequest => ({
    gate: 'tool_function.import', subject: `${subject} ${spec}`, label: 'l', fallback: false,
    standing: [{ subject: `${subject} ${spec}`, label: 'x' }, { subject: `* ${spec}`, label: 'y' }],
    separators: [':', '/'],
  });
  const snap = await policy({ 'tool_function.import': { '*': ['* node:', 'probe lodash', 'probe @aws-sdk/'] } }).gate.snapshot(NOWHERE);
  assert.deepEqual(snap(imp('other', 'node:fs/promises')), permitted('configuration'), '* node: covers any builtin, any depth');
  assert.deepEqual(snap(imp('probe', 'lodash')), permitted('configuration'));
  assert.deepEqual(snap(imp('probe', 'lodash-es')), refused('fallback'), 'lodash does not end at a boundary, so is exact');
  assert.deepEqual(snap(imp('probe', '@aws-sdk/client-s3')), permitted('configuration'), 'a configured scope covers its packages');
});

// ── Snapshots: the answer with nobody to ask, queried synchronously ────────────

test('the asking gate\'s snapshot is the call site\'s fallback', async () => {
  const snap = await askPermissionGate.snapshot(NOWHERE);
  assert.deepEqual(snap(req({ fallback: false })), refused('fallback'));
  assert.deepEqual(snap(req({ fallback: true })), permitted('fallback'));
});

test('the default gate\'s snapshot answers as decide would with nobody to ask, from one read', async () => {
  const { gate, settings } = policy({ 'tool_function.import': { '*': ['* node:os'] } });
  await settings.set('deny:tool_function.import', { '*': ['probe node:'] });
  const snap = await gate.snapshot(NOWHERE);
  assert.deepEqual(snap(importReq({ subject: 'other node:os', standing: [{ subject: '* node:os', label: 'x' }] })),
                   permitted('configuration'), 'a configured allow');
  assert.deepEqual(snap(importReq()), refused('configuration'), 'a stored denial, by a standing subject');
  assert.deepEqual(snap(req({ gate: 'plugin.add' })), refused('fallback'), 'nothing in force: the fallback');

  // Read in advance: an answer stored afterwards is not seen until a fresh snapshot is taken.
  await settings.set('plugin.add', { '*': ['@x/foo'] });
  assert.deepEqual(snap(req({ gate: 'plugin.add' })), refused('fallback'));
  assert.deepEqual((await gate.snapshot(NOWHERE))(req({ gate: 'plugin.add' })), permitted('configuration'));
});

test('the default gate\'s snapshot delegates to the displaced gate\'s, as decide does', async () => {
  const previous: PermissionGate = {
    async decide() { return refused('acme-directory'); },
    async snapshot() { return () => refused('acme-directory'); },
  };
  const { gate } = policy(undefined, previous);
  assert.deepEqual((await gate.snapshot(NOWHERE))(req({ fallback: true })), refused('acme-directory'));
});

test('a bound snapshot is qualified and namespace-checked as the gate is', async () => {
  const asked: string[] = [];
  const gate: PermissionGate = {
    async decide() { return permitted('user'); },
    async snapshot() { return r => { asked.push(r.gate); return permitted('configuration'); }; },
  };
  const tools = { resolve: (n: string) => n === 'tool_function' ? { pluginName: '@matatbread/matbot-function-tools' } : null };
  const fn = { name: 'scrape_prices', pluginName: '@matatbread/matbot-function-tools' };
  const snap = await bindGate(gate, fn, undefined, NOWHERE, tools).gateSnapshot();
  snap({ gate: 'fs-read', subject: 's', label: 'l', fallback: false, namespace: 'tool_function' });
  assert.deepEqual(asked, ['tool_function.fs-read']);
  const rogue = await bindGate(gate, { name: 'rogue', pluginName: '@x/rogue' }, undefined, NOWHERE, tools).gateSnapshot();
  assert.throws(() => rogue({ gate: 'fs-read', subject: 's', label: 'l', fallback: false, namespace: 'tool_function' }), /same plugin/);
});

test('gate_action reports denials beside answers, and clear forgets them', async () => {
  const { settings } = policy({ 'plugin.add': { '*': ['@x/ok'] } });
  await settings.set('deny:tool_function.import', { '*': ['probe node:os'] });
  const tool = makeGateActionTool(settings);
  const ctx = { gate: async () => ({ allowed: true, source: 'user' }) } as never;
  const run = async (p: object): Promise<unknown> => {
    let v: unknown;
    for await (const ev of tool.executor.execute(p, ctx)) if (ev.type === 'result') v = ev.value;
    return v;
  };
  assert.deepEqual(await run({ action: 'get' }), {
    answers: [{ gate: 'plugin.add', effect: 'subjects', subjects: ['@x/ok'] }],
    denials: [{ gate: 'tool_function.import', effect: 'subjects', subjects: ['probe node:os'] }],
  });
  assert.deepEqual(await run({ action: 'get', gate: 'plugin.add' }), { answers: [{ gate: 'plugin.add', effect: 'subjects', subjects: ['@x/ok'] }] },
                   'no denials key when there are none — the shape a reader before denials expects');
  const cleared = await run({ action: 'clear', gate: 'tool_function.import', subject: 'probe node:os' }) as { cleared: string[] };
  assert.deepEqual(cleared.cleared, ['deny:tool_function.import:probe node:os']);
  assert.deepEqual(await settings.get('deny:tool_function.import'), { '*': [] });
  await settings.set('deny:tool_function.import', { '*': ['probe node:os'] });
  await run({ action: 'clear', gate: 'tool_function.import' });
  assert.equal(await settings.get('deny:tool_function.import'), undefined, 'clearing a gate forgets its denials');
});

test('with nobody to ask, the policy delegates to the gate it displaced', async () => {
  // Composition is capture-and-delegate: the pair composes in either load order, because the
  // displaced gate is captured rather than shadowed.
  const seen: PermissionRequest[] = [];
  const previous: PermissionGate = { async decide(r) { seen.push(r); return permitted('user'); } };
  const { gate } = policy(undefined, previous);

  assert.equal((await gate.decide(req({ fallback: false }), undefined, NOWHERE)).allowed, true, 'the predecessor decides');
  assert.deepEqual(seen.map(r => r.subject), ['@x/foo']);

  // And with no predecessor it is the site's own fallback, which is what the host default answers too.
  const alone = policy();
  assert.equal((await alone.gate.decide(req({ fallback: true }), undefined, NOWHERE)).allowed, true);
  assert.equal((await alone.gate.decide(req({ fallback: false }), undefined, NOWHERE)).allowed, false);
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
      return previous.decide(r, ask, NOWHERE);        // must reach `boot`, not recurse into this gate
    },
  });

  assert.equal((await host.PermissionGate.decide(req(), undefined, NOWHERE)).allowed, false);
  assert.equal((await host.PermissionGate.decide(req({ gate: 'tools.overwrite', fallback: true }), undefined, NOWHERE)).allowed, true);
  assert.deepEqual(asked, ['boot:tools.overwrite'], 'the displaced gate decided, exactly once');

  // And unloading the policy reverts to the host's boot default rather than dangling on the gone impl.
  host.unregister();
  assert.equal((await host.PermissionGate.decide(req({ gate: 'plugin.add', fallback: true }), undefined, NOWHERE)).allowed, true);
});

test('the shipped policy delegates without recursing when it displaces a live one', async () => {
  // The same shape with the real policy in the middle: createDefaultGate(settings, previous) is the
  // documented composition, and `previous` here is captured from the registry the way a plugin does.
  const host = hostRegistry({ async decide() { return permitted('user'); } });
  const { settings } = policy();
  host.register(createDefaultGate(settings, host.PermissionGate));

  // No channel, nothing stored: the policy defers, and the deferral must terminate.
  assert.equal((await host.PermissionGate.decide(req({ fallback: false }), undefined, NOWHERE)).allowed, true);
});

test('two "Always allow" answers at once keep both subjects', async () => {
  // Appending a subject is a read-modify-write and PluginSettings has no CAS on the value, so the two
  // writes must be serialised: unguarded, both read the same list and the second drops the first.
  const { gate, settings } = policy();
  await Promise.all([
    gate.decide(req({ subject: '@x/foo' }), recorder('0|always|allow').ask, NOWHERE),
    gate.decide(req({ subject: '@y/bar' }), recorder('0|always|allow').ask, NOWHERE),
  ]);
  assert.deepEqual((await settings.get<Record<string, string[]>>('plugin.add'))?.['*']?.slice().sort(), ['@x/foo', '@y/bar']);
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
  const { gate, settings } = policy({ 'tools.overwrite': { '*': ['bash'] } });
  const tool = makeGateActionTool(settings);
  const configured = await run<{ answers: { gate: string; effect: string; subjects?: string[] }[] }>(
    tool, { action: 'get' });
  assert.deepEqual(configured.answers, [{ gate: 'tools.overwrite', effect: 'subjects', subjects: ['bash'] }]);

  // An answer given at a prompt reads the same way as one an installation configured, and joins it.
  await gate.decide(req(), recorder('0|always|allow').ask, NOWHERE);
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
  const { gate, settings } = policy({ 'plugin.add': { '*': ['@configured/one'] } });
  const tool = makeGateActionTool(settings);

  await gate.decide(req({ subject: '@x/foo' }), recorder('0|always|allow').ask, NOWHERE);
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), recorder('0|once|deny').ask, NOWHERE)).allowed, true);

  // One subject out of the stored list; the rest of the list stands.
  await run(tool, { action: 'clear', gate: 'plugin.add', subject: '@x/foo' });
  const asked = recorder('0|once|deny');
  assert.equal((await gate.decide(req({ subject: '@x/foo' }), asked.ask, NOWHERE)).allowed, false);
  assert.equal(asked.asked.length, 1);
  assert.equal((await gate.decide(req({ subject: '@configured/one' }), asked.ask, NOWHERE)).allowed, true);

  // The whole gate: delete means "revert to the configured default", so the floor comes back.
  await gate.decide(req({ subject: '@x/foo' }), recorder('0|always|allow').ask, NOWHERE);
  const cleared = await run<{ cleared: string[]; message: string }>(tool, { action: 'clear', gate: 'plugin.add' });
  assert.deepEqual(cleared.cleared, ['plugin.add']);
  assert.equal((await gate.decide(req({ subject: '@configured/one' }), asked.ask, NOWHERE)).allowed, true,
    'the installation floor is not a stored answer, so clearing cannot delete it');
  assert.match(cleared.message, /configured defaults/,
    'and the result says so, since the gate is still allowed for what config named');
});

test('clear does not claim to have cleared a configured default', async () => {
  // `delete` reverts to the configured default, so for a gate answered ONLY in default_settings there
  // is nothing stored to remove and nothing changes. Listing it as cleared was a success report for a
  // no-op — the one thing a permissions tool must not do.
  const { settings } = policy({ 'tools.overwrite': { '*': ['bash'] } });
  const tool = makeGateActionTool(settings);

  const result = await run<{ cleared: string[]; message: string }>(tool, { action: 'clear' });
  assert.deepEqual(result.cleared, [], 'nothing was cleared, because nothing was stored');
  assert.match(result.message, /configured defaults/);
  assert.match(result.message, /tools\.overwrite/, 'and it names what is still in force');

  // Still in effect afterwards — the report and the behaviour agree.
  const still = await run<{ answers: { gate: string }[] }>(tool, { action: 'get' });
  assert.deepEqual(still.answers.map(a => a.gate), ['tools.overwrite']);
});

// ── gate_action: entries by id ────────────────────────────────────────────────
// Forgetting one answer used to mean retyping its subject exactly — `Hubs__check@752d… http://…` — and
// the policy cannot offer "everything for this host" as such, because a subject's format is its call
// site's. So `list` finds entries by substring and gives each an id, and `clear` takes the ids back.

interface Entry { id: string; gate: string; effect: 'allow' | 'deny'; subject?: string }

function withCtx(answer: boolean): { ctx: never; asked: { gate: string; subject: string }[] } {
  const asked: { gate: string; subject: string }[] = [];
  return { asked, ctx: { gate: async (r: { gate: string; subject: string }) => { asked.push(r); return { allowed: answer, source: 'user' }; } } as never };
}
async function call<T>(tool: ReturnType<typeof makeGateActionTool>, input: object, ctx: never = withCtx(true).ctx): Promise<T> {
  for await (const ev of tool.executor.execute(input, ctx)) {
    if (ev.type === 'result') return ev.value as T;
    if (ev.type === 'error')  throw new Error(ev.message);
  }
  throw new Error('no result');
}

test('list finds entries by substring, each with an id clear takes back', async () => {
  const { settings } = policy();
  await settings.set('tool_function.connect', { '*': ['Hubs__check@aa http://house:8123', 'mqtt@bb http://192.168.0.8:8088', 'Hubs__check@cc http://house:8123'] });
  await settings.set('http.request', { '*': ['http://house:8800', 'http://100.120.82.75'] });
  const tool = makeGateActionTool(settings);

  const house = (await call<{ entries: Entry[] }>(tool, { action: 'list', match: 'house' })).entries;
  assert.deepEqual(house.map(e => `${e.gate} ${e.subject}`), [
    'tool_function.connect Hubs__check@aa http://house:8123',
    'tool_function.connect Hubs__check@cc http://house:8123',
    'http.request http://house:8800',
  ]);
  const again = (await call<{ entries: Entry[] }>(tool, { action: 'list', match: 'house' })).entries;
  assert.deepEqual(again.map(e => e.id), house.map(e => e.id), 'an id is what the entry is, so it is stable');

  const result = await call<{ cleared: string[] }>(tool, { action: 'clear', ids: house.map(e => e.id) });
  assert.deepEqual(result.cleared, house.map(e => e.id));
  assert.deepEqual(await settings.get('tool_function.connect'), { '*': ['mqtt@bb http://192.168.0.8:8088'] });
  assert.deepEqual(await settings.get('http.request'), { '*': ['http://100.120.82.75'] });

  const stale = await call<{ cleared: string[]; message: string }>(tool, { action: 'clear', ids: [house[0]!.id] });
  assert.deepEqual(stale.cleared, []);
  assert.match(stale.message, /No entry has id/, 'a stale id is reported, never matched to something else');
});

test('an allow of every subject is one entry, and clearing it deletes the key', async () => {
  const { settings } = policy();
  await settings.set('plugin.add', { '*': true });
  const tool = makeGateActionTool(settings);
  const [entry] = (await call<{ entries: Entry[] }>(tool, { action: 'list', gate: 'plugin.add' })).entries;
  assert.deepEqual({ ...entry, id: undefined }, { id: undefined, gate: 'plugin.add', effect: 'allow' });
  await call(tool, { action: 'clear', ids: [entry!.id] });
  assert.equal(await settings.get('plugin.add'), undefined);
});

test('forgetting an allow asks nobody; forgetting a denial asks the user, and a refusal keeps it', async () => {
  const { settings } = policy();
  await settings.set('http.request', { '*': ['http://a'] });
  await settings.set('deny:http.request', { '*': ['http://b'] });
  const tool = makeGateActionTool(settings);
  const entries = (await call<{ entries: Entry[] }>(tool, { action: 'list' })).entries;

  const no = withCtx(false);
  const result = await call<{ cleared: string[]; message: string }>(tool, { action: 'clear', ids: entries.map(e => e.id) }, no.ctx);
  assert.deepEqual(no.asked.map(r => [r.gate, r.subject]), [['forget-denial', 'deny:http.request http://b']], 'asked about the denial only');
  assert.deepEqual(result.cleared, [entries.find(e => e.effect === 'allow')!.id]);
  assert.match(result.message, /the user declined/);
  assert.deepEqual(await settings.get('http.request'), { '*': [] });
  assert.deepEqual(await settings.get('deny:http.request'), { '*': ['http://b'] }, 'the denial stands');

  // The old forms reach denials too, and are asked about the same way.
  await call(tool, { action: 'clear', gate: 'http.request' }, no.ctx);
  assert.deepEqual(await settings.get('deny:http.request'), { '*': ['http://b'] });
  await call(tool, { action: 'clear' }, withCtx(true).ctx);
  assert.equal(await settings.get('deny:http.request'), undefined);
});

test('two clears at once each remove their own entry and restore nothing', async () => {
  // Each used to write back the list it had read, filtered: the second write restored what the first removed.
  const { settings } = policy();
  await settings.set('http.request', { '*': ['http://a', 'http://b'] });
  const tool = makeGateActionTool(settings);
  const [a, b] = (await call<{ entries: Entry[] }>(tool, { action: 'list' })).entries;
  await Promise.all([call(tool, { action: 'clear', ids: [a!.id] }), call(tool, { action: 'clear', ids: [b!.id] })]);
  assert.deepEqual(await settings.get('http.request'), { '*': [] });
});

test('the report does not promise a prompt that a broader answer will pre-empt', async () => {
  const { settings } = policy();
  await settings.set('tool_function.import', { '*': ['probe node:os', '* node:os'] });
  const tool = makeGateActionTool(settings);
  const result = await call<{ message: string }>(tool, { action: 'clear', gate: 'tool_function.import', subject: 'probe node:os' });
  assert.doesNotMatch(result.message, /ask .* again/);
  assert.match(result.message, /Other standing answers remain for tool_function\.import/);
});

// ── Most specific wins ────────────────────────────────────────────────────────
// Where stored answers disagree, the one covering the narrowest of the subjects the call site offered wins
// — then the deeper prefix, then a session's answer over one held everywhere, then a denial on a tie.

const builtin = (spec: string): PermissionRequest => ({
  gate: 'tool_function.import', subject: `probe ${spec}`, label: 'l', fallback: false,
  standing: [{ subject: `probe ${spec}`, label: 'a' }, { subject: 'probe node:', label: 'b' }, { subject: `* ${spec}`, label: 'c' }],
  separators: [':', '/'],
});

test('an allow of one module inside a denial of every builtin admits that module and nothing else', async () => {
  const { gate } = policy({ 'tool_function.import': { '*': ['* node:fs'] }, 'deny:tool_function.import': { '*': ['* node:'] } });
  const snap = await gate.snapshot(NOWHERE);
  assert.deepEqual(snap(builtin('node:fs')), permitted('configuration'), 'the narrower answer wins');
  assert.deepEqual(snap(builtin('node:os')), refused('configuration'));
  assert.deepEqual(snap(builtin('node:fs/promises')), refused('configuration'),
                   'another module: `* node:fs` ends at no boundary, so covers only itself');
  assert.deepEqual(await gate.decide(builtin('node:fs'), recorder('0|once|deny').ask, NOWHERE), permitted('configuration'));
});

test('a directory allowed for one function reopens it inside a denial for every function', async () => {
  const fs = (fn: string, file: string, dir: string): PermissionRequest => ({
    gate: 'tool_function.fs-read', subject: `${fn} ${file}`, label: 'l', fallback: false,
    standing: [{ subject: `${fn} ${file}`, label: 'a' }, { subject: `${fn} ${dir}`, label: 'b' }, { subject: `* ${dir}`, label: 'c' }],
    separators: ['/'],
  });
  const snap = await policy({
    'tool_function.fs-read':      { '*': ['probe /home/me/photos/'] },
    'deny:tool_function.fs-read': { '*': ['* /home/me/'] },
  }).gate.snapshot(NOWHERE);
  assert.deepEqual(snap(fs('probe', '/home/me/photos/2026/a.jpg', '/home/me/photos/2026/')), permitted('configuration'));
  assert.deepEqual(snap(fs('other', '/home/me/photos/2026/a.jpg', '/home/me/photos/2026/')), refused('configuration'));
  assert.deepEqual(snap(fs('probe', '/home/me/notes.txt', '/home/me/')), refused('configuration'));
});

test('the call site\'s order outranks the scope: a broad session allow does not lift a narrow standing denial', async () => {
  const s = 'rank-session';
  const { gate } = policy({ 'deny:tool_function.import': { '*': ['probe node:os'] }, 'tool_function.import': { [s]: ['* node:os'] } });
  assert.deepEqual((await gate.snapshot({ session: s }))(builtin('node:os')), refused('configuration'));
});

test('at the same subject a session\'s answer wins over one held everywhere, and a denial wins a tie', async () => {
  const s = 'rank-tie';
  const { gate } = policy({ 'deny:plugin.add': { '*': ['@x/foo'] }, 'plugin.add': { [s]: ['@x/foo'] } });
  assert.deepEqual(await gate.decide(req(), undefined, { session: s }), permitted('session'));
  assert.deepEqual(await gate.decide(req(), undefined, NOWHERE), refused('configuration'));
  const tie = policy({ 'deny:plugin.add': { '*': ['@x/foo'] }, 'plugin.add': { '*': ['@x/foo'] } });
  assert.deepEqual(await tie.gate.decide(req(), undefined, NOWHERE), refused('configuration'));
});

// ── For this session ──────────────────────────────────────────────────────────

test('"for this session" holds in that session only, is kept in memory, and is seen by its snapshots', async () => {
  const s = 'session-memory-1';
  const { gate, docs } = policy();
  const first = recorder('1|session|allow');
  assert.deepEqual(await gate.decide(importReq(), first.ask, { session: s }), permitted('user'));
  assert.equal(docs.size, 0, 'nothing written: a session answer is kept in memory by default');

  const again = recorder('0|once|deny');
  assert.deepEqual(await gate.decide(importReq({ subject: 'probe node:fs', standing: [{ subject: 'probe node:fs', label: 'x' }, { subject: 'probe node:', label: 'y' }] }),
                   again.ask, { session: s }), permitted('session'), 'the remembered generalisation covers another builtin');
  assert.equal(again.asked.length, 0);
  assert.deepEqual((await gate.snapshot({ session: s }))(importReq()), permitted('session'));
  assert.deepEqual(await gate.decide(importReq(), undefined, { session: 'session-memory-other' }), refused('fallback'), 'another session is asked');
  assert.deepEqual(await gate.decide(importReq(), undefined, NOWHERE), refused('fallback'));
  await runAs({ id: 'someone-else', type: 'user' }, async () => {
    assert.deepEqual(await gate.decide(importReq(), undefined, { session: s }), refused('fallback'),
                     'an answer one principal gave for their work is not another principal\'s');
  });
});

test('a session denial refuses unasked in that session, and says so', async () => {
  const s = 'session-deny-1';
  const { gate } = policy();
  assert.deepEqual(await gate.decide(req(), recorder('0|session|deny').ask, { session: s }), refused('user'));
  const d = await gate.decide(req(), recorder('0|once|allow').ask, { session: s });
  assert.deepEqual(d, refused('session'));
  assert.match(refusalMessage(d), /declined it for this session/);
});

test('"#session-store: settings" persists a session answer under the session\'s id', async () => {
  const s = 'session-persisted-1';
  const { gate, settings } = policy({ '#session-store': 'settings' });
  await gate.decide(importReq(), recorder('0|session|allow').ask, { session: s });
  assert.deepEqual(await settings.get('tool_function.import'), { [s]: ['probe node:os'] });
  assert.deepEqual(await gate.decide(importReq(), undefined, { session: s }), permitted('session'));
});

test('a session lifetime is offered only where there is a session someone works in, and as the call site permits', async () => {
  const labels = async (context: PermissionContext, over: Partial<PermissionRequest> = {}): Promise<string[]> => {
    const seen = recorder('0|once|deny');
    await policy().gate.decide(req(over), seen.ask, context);
    return seen.asked[0]?.options?.map(optionLabel) ?? [];
  };
  assert.deepEqual(await labels({ session: 'offer-1' }), [
    'Deny', 'Deny for this session', 'Always deny', 'Allow',
    'Allow "@x/foo" for this session', 'Always allow "@x/foo"', 'Always allow every plugin.add',
  ]);
  assert.deepEqual(await labels(NOWHERE), ['Deny', 'Always deny', 'Allow', 'Always allow "@x/foo"', 'Always allow every plugin.add']);
  assert.deepEqual(await labels({ session: HTTP_TOOL_SESSION }), await labels(NOWHERE), 'a door sentinel is not a session');
  assert.deepEqual(await labels({ session: 'offer-1' }, { lifetimes: ['session'] }),
                   ['Deny', 'Deny for this session', 'Allow', 'Allow "@x/foo" for this session']);

  const seen = recorder('0|once|deny');
  await policy().gate.decide(req(), seen.ask, { session: 'offer-1' });
  // What, for how long, then the verb — the last drawn as the buttons that answer.
  assert.deepEqual(seen.asked[0]?.axes?.map(a => [a.name, a.label, a.options.map(optionValue), a.submit]), [
    ['subject', 'plugin.add', ['0', 'every'], undefined],
    ['lifetime', undefined, ['once', 'session', 'always'], undefined],
    ['effect', undefined, ['allow', 'deny'], true],
  ]);
});

test('an answer naming a lifetime or subject that was not offered is a refusal and stores nothing', async () => {
  const { gate, docs } = policy();
  assert.deepEqual(await gate.decide(req(), recorder('0|session|allow').ask, NOWHERE), refused('user'), 'no session here');
  assert.deepEqual(await gate.decide(req(), recorder('9|always|allow').ask, NOWHERE), refused('user'));
  assert.deepEqual(await gate.decide(req(), recorder('0|always|allow|x').ask, NOWHERE), refused('user'));
  assert.deepEqual(await gate.decide(req({ lifetimes: ['session'] }), recorder('0|always|allow').ask, { session: 'x' }), refused('user'),
                   'a lifetime the call site does not permit');
  assert.equal(docs.size, 0);
});

test('an answer for the HTTP door is configured against #http, and one held everywhere applies there too', async () => {
  const { gate } = policy({ 'http.request': { [HTTP_TOOL_SESSION]: ['https://a'], '*': ['https://b'] } });
  const at = (subject: string, session?: string) =>
    gate.decide({ gate: 'http.request', subject, label: 'l', fallback: false }, undefined, session === undefined ? NOWHERE : { session });
  assert.deepEqual(await at('https://a', HTTP_TOOL_SESSION), permitted('configuration'));
  assert.deepEqual(await at('https://a', 'a-real-session'), refused('fallback'));
  assert.deepEqual(await at('https://b', HTTP_TOOL_SESSION), permitted('configuration'));
});

test('gate_action lists a session answer as such, and clear forgets it', async () => {
  const s = 'session-listed-1';
  const { gate, settings } = policy();
  await gate.decide(req({ subject: '@x/listed' }), recorder('0|session|allow').ask, { session: s });
  const tool = makeGateActionTool(settings);
  const { entries } = await call<{ entries: (Entry & { session?: string; inMemory?: true })[] }>(tool, { action: 'list', match: s });
  assert.deepEqual(entries.map(({ id: _, ...e }) => e), [{ gate: 'plugin.add', effect: 'allow', session: s, inMemory: true, subject: '@x/listed' }]);
  await call(tool, { action: 'clear', ids: [entries[0]!.id] });
  assert.deepEqual(await gate.decide(req({ subject: '@x/listed' }), undefined, { session: s }), refused('fallback'));
});

// ── The unscoped format ───────────────────────────────────────────────────────

test('stored answers in the unscoped format are migrated once; configured ones are ignored, said so, and never copied', async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    const { gate, settings, docs } = policy(
      { 'deny:tools.overwrite': ['bash'] },
      undefined,
      { 'plugin.add': ['@x/foo'], 'deny:http.request': true, '#session-store': 'memory' },
    );
    assert.deepEqual(await gate.decide(req(), undefined, NOWHERE), permitted('configuration'), 'a migrated allow still applies');
    const data = (docs.get(slugSettingsNamespace(DEFAULT_GATE_SETTINGS_NS)) as SettingsDoc).data;
    assert.deepEqual(data, { 'plugin.add': { '*': ['@x/foo'] }, 'deny:http.request': { '*': true }, '#session-store': 'memory' },
                     'the stored document is rewritten; the configured default is not copied into it; options are left alone');
    const overwrite = { gate: 'tools.overwrite', subject: 'bash', label: 'l', fallback: true };
    assert.deepEqual(await gate.decide(overwrite, undefined, NOWHERE), permitted('fallback'), 'an unscoped configured denial is not read');
    await gate.decide(overwrite, undefined, NOWHERE);
    assert.equal(warned.filter(w => w.includes('"deny:tools.overwrite"')).length, 1, 'and is warned about once');
    assert.equal(await settings.get('deny:tools.overwrite') !== undefined, true);
  } finally { console.warn = orig; }
});

test('gate_action asked first after an upgrade lists what was stored in the unscoped format', async () => {
  const { settings } = policy(undefined, undefined, { 'http.request': ['http://house:8800'] });
  // By gate: session answers earlier tests gave are still in this process's memory, as they would be in matbot's.
  const { entries } = await call<{ entries: Entry[] }>(makeGateActionTool(settings), { action: 'list', gate: 'http.request' });
  assert.deepEqual(entries.map(e => [e.gate, e.subject]), [['http.request', 'http://house:8800']]);
});
