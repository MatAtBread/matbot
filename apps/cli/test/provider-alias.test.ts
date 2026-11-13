import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  createMessage, createSession, usageEntries, bindGate, failureOf, CONFIRM_YES,
} from '@matatbread/matbot-core';
import type {
  CompletionEvent, FormField, MatbotPlugin, Message, ProviderAdapter, ProviderConfig, PromptFn, ToolContext, ToolEvent,
} from '@matatbread/matbot-core';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';
import { parseConfig } from '../src/config-parse.js';
import { parseYaml } from '../src/yaml.js';
import { createProviderTool } from '../src/plugins/tools/provider.js';
import { toGeminiContents } from '../../../plugins/providers/google/src/convert.ts';
import { toOAIMessages } from '../../../plugins/providers/openai-compat/src/convert.ts';

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

const profile = (name: string, model = `${name}-model`): ProviderConfig => ({ name, module: 'fake-adapter', model });

// ── The one-hop rule, held by the registry whoever writes ──────────────────────

test('an alias must point at a profile that exists, and never at another alias or itself', () => {
  const r = new ProviderRegistryImpl([['real', profile('real')]]);
  assert.throws(() => r.register({ name: 'role', alias: 'nope' }), /no provider of that name/);
  assert.throws(() => r.register({ name: 'role', alias: 'role' }), /alias of itself/);
  r.register({ name: 'role', alias: 'real' });
  r.register(profile('other'));
  assert.throws(() => r.register({ name: 'role2', alias: 'role' }), /itself an alias \(of "real"\)\. Point it at "real"/);
  assert.throws(() => r.register({ name: 'real', alias: 'other' }), /cannot become an alias: "role" points at it/);
  assert.equal(r.has('role'), true, 'an alias is a name a caller may use anywhere a profile\'s is');
  assert.equal(r.resolve('role'), r.get('real'));
  assert.equal(r.resolve('real'), r.get('real'));
  assert.equal(r.resolve('missing'), undefined);
});

test('a profile an alias points at cannot be removed, but revert never refuses and resolve says what is wrong', () => {
  const r = new ProviderRegistryImpl([['role', { name: 'role', alias: 'real' }], ['real', profile('real')]]);
  assert.throws(() => r.remove('real'), /"role" is an alias of it/);
  r.register(profile('late'));
  r.register({ name: 'late-role', alias: 'late' });
  r.revert('late');   // a plugin unloading what it contributed: must complete
  assert.equal(r.has('late'), false);
  assert.throws(() => r.resolve('late-role'), (e: Error) =>
    /alias of "late", which is not a configured provider profile/.test(e.message) && failureOf(e) === 'invalid');
  assert.equal(r.remove('role'), true);
  assert.equal(r.remove('real'), true);
});

test('the registry checks aliases once every entry is in, so order in a config does not matter', () => {
  assert.doesNotThrow(() => new ProviderRegistryImpl([['role', { name: 'role', alias: 'real' }], ['real', profile('real')]]));
  assert.throws(() => new ProviderRegistryImpl([['a', { name: 'a', alias: 'b' }], ['b', { name: 'b', alias: 'c' }], ['c', profile('c')]]),
    /Provider alias: .*itself an alias/);
});

test('matbot.yaml: an alias is `alias:` and nothing else', () => {
  const cfg = parseConfig(`providers:
  text_classifier:
    alias: ds
  ds:
    module: '@matatbread/matbot-provider-openai-compat'
    model: deepseek-chat
`);
  assert.deepEqual(cfg.providers.get('text_classifier'), { name: 'text_classifier', alias: 'ds' });
  assert.throws(() => parseConfig(`providers:
  text_classifier:
    alias: ds
    parameters:
      temperature: 0
`), /is an alias, which takes nothing but "alias"; remove "parameters"/);
});

// ── Resolved at the bottom: the chosen name is what is kept ────────────────────

async function machine(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-provider-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configs: ProviderConfig[] = [];
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(_messages, config): AsyncIterable<CompletionEvent> {
      configs.push(config);
      return (async function* () {
        yield { type: 'text-delta', delta: 'ok' } as CompletionEvent;
        yield { type: 'usage', inputTokens: 10, outputTokens: 1 } as CompletionEvent;
        yield { type: 'done' } as CompletionEvent;
      })();
    },
  };
  const providers = new ProviderRegistryImpl([
    ['real', profile('real', 'the-model')],
    ['text_classifier', { name: 'text_classifier', alias: 'real' }],
  ]);
  const { services, dispose } = assembleMachine({
    bootBackend: new FilesystemStorageBackend(join(dir, 'boot')),
    vault:       { resolve: async (ref: string) => ref } as never,
    providers,
    version:     '9.9.9',
    host: () => ({
      loadPlugin:   async () => ({ provider: () => adapter }) as unknown as MatbotPlugin,
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: (s: string) => s },
    }),
  });
  t.after(dispose);
  const session = createSession();
  await services.sessions.set(session.id, session);
  return { services, session, configs, providers };
}

test('a turn under an alias runs on its profile, records the alias, and books spend to the profile', { timeout: 15000 }, async t => {
  const m = await machine(t);
  const view = await m.services.run.open({
    sessionId: m.session.id, signal: new AbortController().signal, provider: 'text_classifier',
    principal: { id: 'tester', type: 'user' }, content: [{ type: 'text', text: 'hi' }],
  });
  for await (const ev of view.events) if (ev.type === 'idle') break;
  assert.equal(m.configs[0]?.name, 'real', 'the adapter is handed the profile, which is where an alias stops');
  assert.equal(m.configs[0]?.model, 'the-model');
  const session = (await m.services.sessions.get(m.session.id))!;
  assert.equal(session.messages.findLast(x => x.role === 'assistant')?.providerName, 'text_classifier', 'the name chosen is what is kept');
  assert.deepEqual(usageEntries(session.messages).map(e => e.provider), ['real'], 'an alias moves; the rates are the model\'s');
});

test('complete() through an alias, and a dangling alias fails the turn and the call alike', { timeout: 15000 }, async t => {
  const m = await machine(t);
  assert.equal((await m.services.singleTurn({ provider: 'text_classifier', prompt: 'x' })).text, 'ok');
  assert.equal(m.configs.at(-1)?.name, 'real');

  // A profile a plugin contributed, aliased, then reverted at that plugin's unload.
  m.providers.register(profile('late'));
  m.providers.register({ name: 'text_classifier', alias: 'late' });
  m.providers.revert('late');
  await assert.rejects(m.services.singleTurn({ provider: 'text_classifier', prompt: 'x' }), /alias of "late", which is not a configured/);
  const view = await m.services.run.open({
    sessionId: m.session.id, signal: new AbortController().signal, provider: 'text_classifier',
    principal: { id: 'tester', type: 'user' }, content: [{ type: 'text', text: 'hi' }],
  });
  const errors: string[] = [];
  for await (const ev of view.events) {
    if (ev.type === 'error') errors.push(ev.error);
    if (ev.type === 'idle') break;
  }
  assert.match(errors.join('\n'), /alias of "late", which is not a configured/);
});

// ── The node `provider` tool ───────────────────────────────────────────────────

const CONFIG = `providers:
  real:
    module: '@matatbread/matbot-provider-anthropic'
    model: claude-sonnet-4-6
  other:
    module: '@matatbread/matbot-provider-anthropic'
    model: claude-haiku-4-5

default_settings:
  '@matatbread/matbot-triggers':
    classifierProvider: text_classifier
`;

async function tool(t: { after(fn: () => Promise<void>): void }, input: Record<string, unknown>, providers?: ProviderRegistryImpl) {
  const dir  = await mkdtemp(join(tmpdir(), 'mb-provider-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'matbot.yaml');
  await writeFile(file, CONFIG, 'utf8');
  const reg = providers ?? new ProviderRegistryImpl(parseConfig(CONFIG).providers);
  const prompts: string[] = [];
  const ask = (async (q: unknown) => { prompts.push(typeof q === 'string' ? q : (q as FormField).label); return CONFIRM_YES; }) as PromptFn;
  const ctx = {
    session: { id: 's1', messages: [] }, signal: new AbortController().signal, prompt: ask,
    vault: { hasKey: () => false }, ...bindGate(undefined, 'provider', ask, {}),
  } as unknown as ToolContext;
  const run = async (i: Record<string, unknown>) => {
    const events: ToolEvent<unknown>[] = [];
    for await (const e of createProviderTool(file, reg).executor.execute(i, ctx)) events.push(e);
    return events.find(e => e.type === 'result' || e.type === 'error');
  };
  const first = await run(input);
  return { first, run, reg, prompts, file };
}

const yamlEntry = async (file: string, name: string): Promise<unknown> =>
  (parseYaml(await readFile(file, 'utf8'))['providers'] as Record<string, unknown>)[name];

test('provider alias: created, then repointed, in the file and the live set, each asked first', async t => {
  const { first, run, reg, prompts, file } = await tool(t, { action: 'alias', name: 'text_classifier', alias: 'real' });
  assert.match(JSON.stringify(first), /"text_classifier\\" now runs on \\"real\\"/);
  assert.match(prompts[0]!, /Add provider alias \*\*"text_classifier"\*\* for \*\*"real"\*\* \(claude-sonnet-4-6 via/);
  assert.deepEqual(reg.get('text_classifier'), { name: 'text_classifier', alias: 'real' });
  assert.deepEqual(await yamlEntry(file, 'text_classifier'), { alias: 'real' });

  await run({ action: 'alias', name: 'text_classifier', alias: 'other' });
  assert.match(prompts[1]!, /Point provider alias \*\*"text_classifier"\*\* at \*\*"other"\*\*.*instead of "real"/);
  assert.equal(reg.resolve('text_classifier')?.model, 'claude-haiku-4-5');
  assert.deepEqual(await yamlEntry(file, 'text_classifier'), { alias: 'other' });
  assert.match(await readFile(file, 'utf8'), /default_settings:\n {2}'@matatbread\/matbot-triggers':/, 'the rest of the file is untouched');
  assert.deepEqual(parseConfig(await readFile(file, 'utf8')).providers.get('text_classifier'), { name: 'text_classifier', alias: 'other' });
});

test('provider alias: refusals name what to do instead', async t => {
  const { first, run } = await tool(t, { action: 'alias', name: 'real', alias: 'other' });
  assert.match(JSON.stringify(first), /"real\\" is a provider profile, not an alias/);
  assert.match(JSON.stringify(await run({ action: 'alias', name: 'role', alias: 'missing' })), /no provider of that name is configured\. Configured: real, other/);
  await run({ action: 'alias', name: 'role', alias: 'real' });
  assert.match(JSON.stringify(await run({ action: 'alias', name: 'role2', alias: 'role' })), /itself an alias/);
  assert.match(JSON.stringify(await run({ action: 'update', name: 'role', model: 'x' })), /is an alias of \\"real\\".*Use action \\"alias\\"/);
  assert.match(JSON.stringify(await run({ action: 'remove', name: 'real' })), /"role\\" is an alias of it/);
  const listed = await run({ action: 'list' }) as { value: { providers: { name: string }[]; aliases: unknown[] } };
  assert.deepEqual(listed.value.aliases, [{ name: 'role', alias: 'real' }]);
  assert.deepEqual(listed.value.providers.map(p => p.name), ['real', 'other'], 'a picker reading profiles sees no role names');
  assert.match(JSON.stringify(await run({ action: 'remove', name: 'role' })), /Alias \\"role\\" removed/);
  assert.match(JSON.stringify(await run({ action: 'remove', name: 'real' })), /Profile \\"real\\" removed/);
  assert.match(JSON.stringify(await run({ action: 'remove', name: 'other' })), /only configured provider/);
});

// ── A signature is trusted by the model that minted it ─────────────────────────

const signedCall = (providerName: string, model?: string): Message => ({
  ...createMessage({ role: 'assistant', traceId: 't', providerName, content: [
    { type: 'thinking', thinking: 'hm', signature: 'SIG-T', ...(model !== undefined ? { meta: { google: { model } } } : {}) },
    { type: 'tool-call', id: 'c1', name: 'x', input: {}, meta: { google: { thoughtSignature: 'SIG', ...(model !== undefined ? { model } : {}) } } },
  ] }),
});
const result = createMessage({ role: 'tool', traceId: 't', content: [{ type: 'tool-result', id: 'c1', result: 1 }] });
const gemini = (msgs: Message[], model: string) => JSON.stringify(toGeminiContents(msgs, { name: 'gemini-pro', model }));

test('google: a signature replays to the model that minted it, whatever name the message was run under', () => {
  const underAlias = [signedCall('chat', 'gemini-3-pro'), result];
  assert.match(gemini(underAlias, 'gemini-3-pro'), /"thoughtSignature":"SIG"/, 'an alias name does not make its own history foreign');
  assert.match(gemini(underAlias, 'gemini-3-pro'), /"thoughtSignature":"SIG-T"/);
  assert.doesNotMatch(gemini(underAlias, 'gemini-3-flash'), /SIG/, 'an alias moved to another model does not replay the first one\'s');
  // History from before the model was recorded keeps the old rule: same profile name.
  assert.match(gemini([signedCall('gemini-pro'), result], 'anything'), /"thoughtSignature":"SIG"/);
  assert.doesNotMatch(gemini([signedCall('chat'), result], 'anything'), /SIG/);
});

test('openai-compat gemini mode drops a signature another model minted, and keeps one with no model recorded', () => {
  const wire = (msgs: Message[]) => JSON.stringify(toOAIMessages(msgs, false, true, 'gemini-3-pro'));
  assert.match(wire([signedCall('chat', 'gemini-3-pro'), result]), /thought_signature":"SIG"/);
  assert.doesNotMatch(wire([signedCall('chat', 'gemini-3-flash'), result]), /thought_signature/);
  assert.match(wire([signedCall('chat'), result]), /thought_signature":"SIG"/);
});
