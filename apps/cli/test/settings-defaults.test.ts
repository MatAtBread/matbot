import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePluginSettings, installSettingsDefaults, settingsDefaultNamespaces, parseConfig,
         slugSettingsNamespace } from '@matatbread/matbot-core';
import type { Store, CASResult, QueryResult, SettingsDoc } from '@matatbread/matbot-core';

// `default_settings:` is a read-through FLOOR under the settings store, and the whole design rests on
// two properties that are easy to state and easy to break:
//
//   reads are layered   — stored wins, else the install default, else undefined (so config beats the
//                         plugin's own `?? codeDefault`, and `delete` reverts to the config value);
//   writes are NOT      — setting one key must never persist another key's default, or whether a later
//                         yaml edit takes effect would depend on unrelated write history.
//
// Nothing seeds and nothing writes back, which is what makes a default survive a plugin update and
// apply to every principal rather than only the one that happened to boot.

function memStore(): Store<SettingsDoc> & { docs: Map<string, SettingsDoc> } {
  const docs = new Map<string, SettingsDoc>();
  return {
    docs,
    get: async id => docs.get(id) ?? null,
    set: async (id, v) => { docs.set(id, v); },
    async cas(id, expected, next): Promise<CASResult<SettingsDoc>> {
      const cur = docs.get(id) ?? null;
      if (cur?.version !== expected) return { ok: false, current: cur };
      docs.set(id, next);
      return { ok: true, doc: next };
    },
    delete: async id => docs.delete(id),
    query: async (): Promise<QueryResult<SettingsDoc>> => ({ items: [...docs.values()], total: docs.size }),
  };
}

const NAME = '@matatbread/matbot-triggers';

function withDefaults(defaults: Record<string, Record<string, unknown>>) {
  installSettingsDefaults(new Map(Object.entries(defaults)));
  const store = memStore();
  return { store, settings: makePluginSettings(store, NAME) };
}

test('a default is read when nothing is stored, and only for the key it names', async () => {
  const { settings } = withDefaults({ [NAME]: { classifierProvider: 'fast-haiku' } });
  assert.equal(await settings.get('classifierProvider'), 'fast-haiku');
  assert.equal(await settings.get('somethingElse'), undefined);
});

test('a stored value wins, and delete reverts to the default rather than to absence', async () => {
  const { settings } = withDefaults({ [NAME]: { classifierProvider: 'fast-haiku' } });
  await settings.set('classifierProvider', 'claude-opus-5');
  assert.equal(await settings.get('classifierProvider'), 'claude-opus-5');
  await settings.delete('classifierProvider');
  assert.equal(await settings.get('classifierProvider'), 'fast-haiku');
});

// The Q4 property: seeding on write would pin every OTHER key's default at the moment of an unrelated
// write, so a yaml edit would work or not work depending on what had been written before it.
test('writing one key never persists another key default', async () => {
  const { store, settings } = withDefaults({ [NAME]: { a: 'from-config', b: 'from-config' } });
  await settings.set('a', 'stored');

  const doc = store.docs.get(slugSettingsNamespace(NAME));
  assert.deepEqual(doc?.data, { a: 'stored' });         // b is NOT in the document
  assert.equal(await settings.get('b'), 'from-config'); // and still reads through
});

// `in`, not a truthiness test: null is a value a plugin may treat as "off", and `delete` is the way
// back to the default. If null fell through, a caller could not turn a configured default off.
test('a stored null overrides the default', async () => {
  const { settings } = withDefaults({ [NAME]: { classifierProvider: 'fast-haiku' } });
  await settings.set('classifierProvider', null);
  assert.equal(await settings.get('classifierProvider'), null);
});

test('defaults are scoped to the plugin they name', async () => {
  const { store } = withDefaults({ [NAME]: { classifierProvider: 'fast-haiku' } });
  const other = makePluginSettings(store, '@matatbread/matbot-skills');
  assert.equal(await other.get('classifierProvider'), undefined);
});

// The store id is slugged (document ids are /^[\w-]+$/) but the defaults are keyed by the plugin NAME,
// which is what an author writes in the yaml. The two must not be conflated in either direction.
test('a package-named plugin finds defaults keyed by its name, not its slugged document id', async () => {
  const { store, settings } = withDefaults({ [NAME]: { k: 'v' } });
  assert.equal(await settings.get('k'), 'v');
  await settings.set('k', 'stored');
  assert.deepEqual([...store.docs.keys()], [slugSettingsNamespace(NAME)]);
  assert.notEqual(slugSettingsNamespace(NAME), NAME);
});

test('no defaults installed is the same as an empty floor', async () => {
  installSettingsDefaults(undefined);
  const settings = makePluginSettings(memStore(), NAME);
  assert.equal(await settings.get('classifierProvider'), undefined);
  assert.deepEqual(settingsDefaultNamespaces(), []);
});

// The config half: keys are plugin names, quoted or not, and values are opaque to matbot.
test('default_settings parses into a name-keyed map, quoted or bare', () => {
  const config = parseConfig(`plugins:
  - '@matatbread/matbot-triggers'
default_settings:
  '@matatbread/matbot-triggers':
    classifierProvider: fast-haiku
  @matatbread/matbot-cognition:
    dream:
      maxItems: 5
    innerVoiceProvider: fast-haiku
providers:
  fast-haiku:
    module: '@matatbread/matbot-provider-anthropic'
    model: claude-haiku-4-5
`);
  assert.deepEqual([...(config.defaultSettings ?? new Map())], [
    ['@matatbread/matbot-triggers',  { classifierProvider: 'fast-haiku' }],
    ['@matatbread/matbot-cognition', { dream: { maxItems: 5 }, innerVoiceProvider: 'fast-haiku' }],
  ]);
});

test('a config with no default_settings section carries no map', () => {
  const config = parseConfig(`plugins:
  - '@matatbread/matbot-triggers'
`);
  assert.equal(config.defaultSettings, undefined);
});
