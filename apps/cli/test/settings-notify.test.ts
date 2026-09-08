import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makePluginSettings, installSettingsNotifier, installSettingsDefaults, createNotifier,
         slugSettingsNamespace, ItemChangeKind, runAs, installPrincipalCarrier,
         SETTINGS_NAMESPACE } from '@matatbread/matbot-core';
import type { CASResult, Notification, Notifier, Store, SettingsDoc } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());

// A settings write used to announce nothing, so a reader had a choice between re-reading the store on
// every use (a disk read per tool call, for a value that changes approximately never) and caching with
// unbounded staleness. Neither is a cache; an ItemChange is what makes one possible — "the thing at
// (settings, <slug>) is stale, re-read it", which is exactly what the kind already means.

const NAME = '@matatbread/matbot-ts-validation';

function memStore(): Store<SettingsDoc> {
  const docs = new Map<string, SettingsDoc>();
  return {
    get:   async id => docs.get(id) ?? null,
    set:   async (id, v) => { docs.set(id, v); },
    async cas(id, expected, next): Promise<CASResult<SettingsDoc>> {
      const cur = docs.get(id) ?? null;
      if (cur?.version !== expected) return { ok: false, current: cur };
      docs.set(id, next);
      return { ok: true, doc: next };
    },
    delete: async id => docs.delete(id),
    query:  async () => ({ items: [], total: 0 }),
  };
}

function collect(notifier: Notifier): Notification[] {
  const seen: Notification[] = [];
  notifier.consume(n => { seen.push(n); });
  return seen;
}

afterEach(() => { installSettingsNotifier(undefined); installSettingsDefaults(undefined); });

test('a settings write announces an ItemChange addressing that plugin\'s document', async () => {
  const notifier = createNotifier('core');
  const seen     = collect(notifier);
  installSettingsNotifier(notifier);

  const settings = makePluginSettings(memStore(), NAME);
  await runAs({ id: 'matt', type: 'user' }, async () => {
    await settings.set('enforce', 'warn');
  });
  await new Promise(r => setTimeout(r, 0));

  assert.equal(seen.length, 1);
  const [n] = seen;
  assert.equal(n!.kind, ItemChangeKind);
  assert.deepEqual(
    { ...n, kind: undefined },
    { kind: undefined, plugin: 'core', source: 'settings', namespace: SETTINGS_NAMESPACE,
      id: slugSettingsNamespace(NAME), key: NAME, operation: 'saved',
      principal: { id: 'matt', type: 'user' } },
  );
});

test('`key` is the namespace as the caller wrote it, so no consumer re-derives the slug', async () => {
  // `id` is the medium's address — the package name slugged to satisfy the filesystem store's id rule,
  // and another backend could shape it differently. A consumer asking "are these my settings?" compares
  // `key` against its own `services.self.name`; a copy of the slug rule would keep compiling after that
  // rule changed and simply stop matching, which is silent.
  const notifier = createNotifier('core');
  const seen     = collect(notifier);
  installSettingsNotifier(notifier);

  await makePluginSettings(memStore(), NAME).set('enforce', 'warn');
  await new Promise(r => setTimeout(r, 0));

  const n = seen[0] as { id: string; key?: string };
  assert.equal(n.key, NAME);
  assert.notEqual(n.id, n.key, 'this name is one the medium had to mangle — the case the field exists for');
  assert.equal(n.id, slugSettingsNamespace(NAME));
});

test('the announcement carries the writing principal, since an override is per-principal', async () => {
  const notifier = createNotifier('core');
  const seen     = collect(notifier);
  installSettingsNotifier(notifier);
  const settings = makePluginSettings(memStore(), NAME);

  await runAs({ id: 'a', type: 'user' }, () => settings.set('k', 1));
  await runAs({ id: 'b', type: 'user' }, () => settings.set('k', 2));
  await new Promise(r => setTimeout(r, 0));

  assert.deepEqual(seen.map(n => (n as { principal?: { id: string } }).principal?.id), ['a', 'b']);
});

test('delete announces (the document is still there, minus the key); a no-op delete does not', async () => {
  const notifier = createNotifier('core');
  const seen     = collect(notifier);
  installSettingsNotifier(notifier);
  const settings = makePluginSettings(memStore(), NAME);

  await settings.set('enforce', 'off');
  await settings.delete('never-set');
  await settings.delete('enforce');
  await new Promise(r => setTimeout(r, 0));

  assert.deepEqual(seen.map(n => (n as { operation: string }).operation), ['saved', 'saved']);
});

test('a facade built before the host installs the bus still announces', async () => {
  // The notifier is read per publish, not captured at construction — core builds its own reserved-
  // namespace facade lazily, and a host that installs late must not silence it forever.
  const settings = makePluginSettings(memStore(), NAME);
  const notifier = createNotifier('core');
  const seen     = collect(notifier);
  installSettingsNotifier(notifier);

  await settings.set('enforce', 'reject');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(seen.length, 1);
});

test('with no bus installed a write still works and publishes nothing', async () => {
  const settings = makePluginSettings(memStore(), NAME);
  await settings.set('enforce', 'reject');
  assert.equal(await settings.get('enforce'), 'reject');
});
