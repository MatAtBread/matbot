import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assembleMachine, ProviderRegistryImpl, VaultImpl, loadPlugins, installPrincipalCarrier,
  createConstantPrincipalCarrier, installUsageCarrier, createSerialUsageCarrier, createSession, PLUGIN_API_VERSION,
} from '@matatbread/matbot-core';
import type { MatbotPlugin } from '@matatbread/matbot-core';
import { MemoryStorageBackend } from '@matatbread/matbot-core/storage-base';

// The floor under embedder.test.ts: no host package at all. One principal for the process, nothing
// persisted, plugins resolved by the embedder — a bare name from HERE, since core resolving it would look
// beside core, where the embedder's dependencies are not.

test('this embedder imports nothing but core', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const sources = [...source.matchAll(/^import[^;]*?from '([^']+)'/gms)].map(m => m[1]!);
  assert.deepEqual(sources.filter(s => !/^(node:|@matatbread\/matbot-core(\/storage-base)?$)/.test(s)), []);
});

test('a machine from core alone: in-memory storage, a plugin by package name, a turn', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-core-alone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = join(dir, 'echo-provider');
  await mkdir(provider);
  await writeFile(join(provider, 'package.json'), JSON.stringify({
    name: 'echo-provider', version: '1.0.0', type: 'module', matbotRuntime: ['node'], exports: './index.js',
  }));
  await writeFile(join(provider, 'index.js'), `
    const adapter = {
      name: 'echo-provider',
      async health() { return { ok: true }; },
      async *complete() { yield { type: 'text-delta', delta: 'hello' }; yield { type: 'done' }; },
    };
    export const plugin = { apiVersion: ${JSON.stringify(PLUGIN_API_VERSION)}, provider: () => adapter };
  `);

  installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'me', type: 'user' }));
  installUsageCarrier(createSerialUsageCarrier());

  const backend = new MemoryStorageBackend();
  const { services, loaded } = assembleMachine({
    bootBackend: backend,
    vault:       new VaultImpl({}),
    providers:   new ProviderRegistryImpl([['p', { name: 'p', module: pathToFileURL(join(provider, 'index.js')).href, model: 'm' }]]),
    version:     'embedded',
    host: machine => ({
      async loadPlugin(spec): Promise<MatbotPlugin> {
        const plugin = (await loadPlugins([{ spec, importSpec: import.meta.resolve(spec) }], machine(), false, undefined, 'throw'))[0];
        if (plugin === undefined) throw new Error(`No plugin loaded for "${spec}"`);
        return plugin;
      },
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: source => source },
    }),
  });
  await services.loadPlugin('@matatbread/matbot-sessions');
  loaded();

  const names = services.tools.list().map(tool => tool.name);
  assert.ok(names.includes('session_action'), 'the plugin loaded by package name');
  assert.ok(names.includes('gate_action'));

  const session = createSession();
  await services.sessions!.set(session.id, session);
  const view = await services.run!.open({
    sessionId: session.id, signal: new AbortController().signal, provider: 'p',
    principal: { id: 'me', type: 'user' }, content: [{ type: 'text', text: 'hi' }],
  });
  for await (const ev of view.events) if (ev.type === 'idle') break;

  const stored = await services.sessions!.get(session.id);
  assert.match(JSON.stringify(stored!.messages.at(-1)), /hello/);
  assert.ok((await backend.namespaces()).includes('sessions'), 'and the session is in the memory backend');
});

test('MemoryFileStore: a named put replaces, an anonymous one does not, a handle keeps its bytes', async () => {
  const files = new MemoryStorageBackend().fileStore;
  const bytes = async function* (s: string) { yield new TextEncoder().encode(s); };
  const read  = async (h: { stream(): AsyncIterable<Uint8Array> }) => {
    let s = ''; for await (const c of h.stream()) s += new TextDecoder().decode(c); return s;
  };

  const first  = await files.put('a.txt', 'text/plain', bytes('one'), { namespace: 'n', sessionId: 's' });
  const second = await files.put('a.txt', 'text/plain', bytes('two!'), { namespace: 'n', sessionId: 's' });
  assert.equal(second.id, 'a.txt');
  assert.equal(second.size, 4);
  assert.notEqual(second.version, first.version);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(await read(first), 'one');
  assert.equal(await read((await files.get('a.txt'))!), 'two!');

  const anon = await files.put(undefined, 'image/png', bytes('x'), { namespace: 'm' });
  assert.notEqual(anon.id, 'a.txt');
  assert.equal((await files.getByName('a.txt', 'm')), null);
  assert.equal((await files.getByName('a.txt', 'n'))!.id, 'a.txt');

  const listed = async (f: Parameters<typeof files.list>[0]) => { const ids = []; for await (const h of files.list(f)) ids.push(h.id); return ids; };
  assert.deepEqual(await listed({ sessionId: 's' }), ['a.txt']);
  assert.deepEqual(await listed({ mimeType: 'image/' }), [anon.id]);

  await files.delete('a.txt');
  assert.equal(await files.get('a.txt'), null);
});

test('MemoryStorageBackend.namespaces lists what holds documents, sorted', async () => {
  const backend = new MemoryStorageBackend();
  backend.createStore('empty');
  await backend.createStore('zeta').set('1', { id: '1', version: 'v' });
  await backend.createStore('alpha').set('1', { id: '1', version: 'v' });
  assert.deepEqual(await backend.namespaces(), ['alpha', 'zeta']);
  assert.equal(backend.createStore('zeta'), backend.createStore('zeta'));
});
