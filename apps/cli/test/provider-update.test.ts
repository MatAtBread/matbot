import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml, applyProviderPatch, patchedFields, ProviderRegistryImpl,
         CONFIRM_YES, CONFIRM_NO } from '@matatbread/matbot-core';
import { writeProviderBlock, createProviderTool } from '@matatbread/matbot-tool-plugin';
import type { ProviderConfig, ToolContext, ToolEvent, FormField } from '@matatbread/matbot-plugin-api';

// `provider update` exists because a provider renaming its models (DeepSeek did) left no way to change
// `model:` on a profile: the only route was remove + add, and `provider list` projects `credentials` down
// to `hasCredentials`, so the caller could not see the `${NAME}` reference it would have to write back.
// The key survived in the vault; the *reference* did not survive the round trip.
//
// So the property under test is not "a field can be set". It is that everything the caller did NOT name
// comes out the other side unchanged — the credential above all, which no part of update may touch.

const CONFIG = `plugins:
  - '@matatbread/matbot-tool-plugin'

providers:
  keep-me:
    module: '@matatbread/matbot-provider-anthropic'
    model: claude-sonnet-4-6
  deepseek:
    module: '@matatbread/matbot-provider-openai-compat'
    endpoint: https://api.deepseek.com
    model: deepseek-chat
    credentials:
      apiKey: \${DEEPSEEK_KEY}
    maxRounds: 12
    parameters:
      maxTokens: 4096
      temperature: 0.2

default_settings:
  '@matatbread/matbot-rumsfeld':
    reranker: bge
`;

async function fixture(): Promise<string> {
  const dir  = await mkdtemp(join(tmpdir(), 'mb-provider-update-'));
  const file = join(dir, 'matbot.yaml');
  await writeFile(file, CONFIG, 'utf8');
  return file;
}

/** The profile as the config parser reads it back — what the next boot would actually load. */
async function readBack(file: string, name: string): Promise<Record<string, unknown>> {
  const doc = parseYaml(await readFile(file, 'utf8'));
  const providers = doc['providers'] as Record<string, Record<string, unknown>>;
  return providers[name]!;
}

function stored(name: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name,
    module:      '@matatbread/matbot-provider-openai-compat',
    endpoint:    'https://api.deepseek.com',
    model:       'deepseek-chat',
    credentials: { apiKey: '${DEEPSEEK_KEY}' },
    maxRounds:   12,
    parameters:  { maxTokens: 4096, temperature: 0.2 },
    ...over,
  };
}

test('a model rename changes the model and nothing else — the credential reference included', async () => {
  const file = await fixture();
  const next = applyProviderPatch(stored('deepseek'), { model: 'deepseek-chat-v2' });

  assert.equal(await writeProviderBlock(file, next), true);

  assert.deepEqual(await readBack(file, 'deepseek'), {
    module:      '@matatbread/matbot-provider-openai-compat',
    endpoint:    'https://api.deepseek.com',
    model:       'deepseek-chat-v2',
    credentials: { apiKey: '${DEEPSEEK_KEY}' },
    maxRounds:   12,
    parameters:  { maxTokens: 4096, temperature: 0.2 },
  });
});

test('every other section and profile survives the rewrite', async () => {
  const file = await fixture();
  await writeProviderBlock(file, applyProviderPatch(stored('deepseek'), { model: 'x' }));

  const doc = parseYaml(await readFile(file, 'utf8'));
  assert.deepEqual(doc['plugins'], ['@matatbread/matbot-tool-plugin']);
  assert.deepEqual(doc['default_settings'], { '@matatbread/matbot-rumsfeld': { reranker: 'bge' } });
  // The untouched sibling profile keeps its own definition, not a copy of anything.
  assert.deepEqual(await readBack(file, 'keep-me'), {
    module: '@matatbread/matbot-provider-anthropic',
    model:  'claude-sonnet-4-6',
  });
});

test('null clears a field, absent leaves it alone', async () => {
  const file = await fixture();
  const next = applyProviderPatch(stored('deepseek'), { endpoint: null, maxRounds: null });

  await writeProviderBlock(file, next);
  const back = await readBack(file, 'deepseek');

  assert.equal('endpoint'  in back, false);
  assert.equal('maxRounds' in back, false);
  assert.equal(back['model'], 'deepseek-chat');                       // absent ⇒ untouched
  assert.deepEqual(back['credentials'], { apiKey: '${DEEPSEEK_KEY}' });
});

test('parameters are replaced wholesale, not merged', () => {
  // Merging per key would make "drop temperature" unexpressible: there is no shape to diff against,
  // since a parameter is whatever the endpoint takes. Replacement is what `list` + edit + send-back
  // means, and the tool description says so.
  const next = applyProviderPatch(stored('deepseek'), { parameters: { maxTokens: 8192 } });
  assert.deepEqual(next.parameters, { maxTokens: 8192 });
});

test('a literal key in the config round-trips as a literal, unquoted', async () => {
  // A `${NAME}` reference is the form everything matbot writes, but a hand-authored config may hold the
  // key itself, and update regenerates the block either way. Neither form may acquire quotes, lose them,
  // or turn into the other.
  const file = await fixture();
  const next = applyProviderPatch(stored('deepseek', { credentials: { apiKey: 'sk-abc123' } }), { model: 'm2' });

  await writeProviderBlock(file, next);
  assert.deepEqual((await readBack(file, 'deepseek'))['credentials'], { apiKey: 'sk-abc123' });
});

test('a profile absent from the file is reported, not appended', async () => {
  // A runtime-contributed profile (one a storage backend replayed from its own medium) has its source of
  // truth elsewhere. Appending a block for it would make matbot.yaml a second, diverging record.
  const file = await fixture();
  assert.equal(await writeProviderBlock(file, stored('replayed-from-drive')), false);

  const doc = parseYaml(await readFile(file, 'utf8'));
  assert.equal('replayed-from-drive' in (doc['providers'] as Record<string, unknown>), false);
});

// Found by the round-trip above, and pre-dating it: the block remover matched every following line that
// did not begin `  <non-space>`, which a top-level key does not. Removing the LAST profile in
// `providers:` therefore deleted `default_settings:`'s header too and left its children indented under
// `providers:` — a config that still parsed, with a settings namespace serving as a provider profile.
// `provider remove` has always been able to do this; `update` (a remove + add of, typically, the last
// profile) would have done it almost every time.
test('removing the last profile does not swallow the section after it', async () => {
  const file = await fixture();
  // `deepseek` is last in `providers:`, and `default_settings:` follows the block.
  await writeProviderBlock(file, applyProviderPatch(stored('deepseek'), { model: 'v2' }));

  const doc = parseYaml(await readFile(file, 'utf8'));
  const providers = doc['providers'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(providers).sort(), ['deepseek', 'keep-me']);
  assert.deepEqual(doc['default_settings'], { '@matatbread/matbot-rumsfeld': { reranker: 'bge' } });
});

// ── The executor, end to end ───────────────────────────────────────────────────

async function runUpdate(
  file:    string,
  input:   Record<string, unknown>,
  answer:  string = CONFIRM_YES,
): Promise<{ events: ToolEvent<unknown>[]; providers: ProviderRegistryImpl; prompts: string[] }> {
  const providers = new ProviderRegistryImpl([
    ['deepseek', stored('deepseek')],
    ['other',    stored('other', { module: '@matatbread/matbot-provider-anthropic' })],
  ]);
  const prompts: string[] = [];
  const ctx = {
    configPath: file,
    session:    { id: 's1', messages: [] },
    signal:     new AbortController().signal,
    // Confirmations are structured `confirm` fields, so record the label a frontend would render.
    prompt:     async (q: unknown) => { prompts.push(typeof q === 'string' ? q : (q as FormField).label); return answer; },
  } as unknown as ToolContext;

  const events: ToolEvent<unknown>[] = [];
  for await (const e of createProviderTool(providers).executor.execute(input, ctx)) events.push(e);
  return { events, providers, prompts };
}

const resultOf = (events: ToolEvent<unknown>[]): unknown =>
  events.find(e => e.type === 'result' || e.type === 'error');

test('the executor writes the file and repoints the live registry together', async () => {
  const file = await fixture();
  const { events, providers, prompts } = await runUpdate(file, { action: 'update', name: 'deepseek', model: 'deepseek-chat-v2' });

  // The confirmation names the change and says what the rewrite costs, before it happens.
  assert.match(prompts[0]!, /deepseek-chat → deepseek-chat-v2/);
  assert.match(prompts[0]!, /comments inside it are lost/);

  assert.deepEqual(resultOf(events), { type: 'result', value: { message: 'Profile "deepseek" updated: model.' } });
  assert.equal(providers.get('deepseek')!.model, 'deepseek-chat-v2');
  assert.equal((await readBack(file, 'deepseek'))['model'], 'deepseek-chat-v2');
  // The live profile keeps its credential, exactly as the file does.
  assert.deepEqual(providers.get('deepseek')!.credentials, { apiKey: '${DEEPSEEK_KEY}' });
});

test('declining the confirmation changes neither the file nor the registry', async () => {
  const file   = await fixture();
  const before = await readFile(file, 'utf8');
  const { events, providers } = await runUpdate(file, { action: 'update', name: 'deepseek', model: 'nope' }, CONFIRM_NO);

  assert.deepEqual(resultOf(events), { type: 'result', value: { message: 'Cancelled.' } });
  assert.equal(providers.get('deepseek')!.model, 'deepseek-chat');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('an update naming no field is refused with the list of fields, not silently applied', async () => {
  const file = await fixture();
  const { events, prompts } = await runUpdate(file, { action: 'update', name: 'deepseek' });

  assert.deepEqual(prompts, []);                                  // nothing to confirm
  const r = resultOf(events) as { value: { message: string } };
  assert.match(r.value.message, /model, endpoint, parameters, maxRounds/);
  assert.match(r.value.message, /plugin store-key/);              // where a key change actually goes
});

test('a value matbot.yaml cannot represent is refused, naming the field', async () => {
  // `#` is stripped to end-of-line by the config tokeniser, quotes included — so writing it would
  // silently truncate a value on the next read. A refusal beats a config that lies.
  const file = await fixture();
  const { events } = await runUpdate(file, { action: 'update', name: 'deepseek', parameters: { stop: 'end # here' } });

  const r = resultOf(events) as { type: string; message: string };
  assert.equal(r.type, 'error');
  assert.match(r.message, /provider\.parameters\.stop contains "#"/);
  assert.equal((await readBack(file, 'deepseek'))['parameters'] !== undefined, true);   // untouched
});

test('patchedFields reports only what the caller named', () => {
  assert.deepEqual(patchedFields({ model: 'm' }), ['model']);
  assert.deepEqual(patchedFields({ maxRounds: null, model: 'm' }), ['model', 'maxRounds']);
  assert.deepEqual(patchedFields({}), []);
});
