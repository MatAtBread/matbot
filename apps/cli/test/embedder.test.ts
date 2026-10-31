import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, installUsageCarrier, runAs, createSession,
  invokeTool, toolResult, PLUGIN_API_VERSION,
} from '@matatbread/matbot-core';
import type { Principal } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier, createAlsUsageCarrier, EnvFileVault, nodePluginMembers } from '@matatbread/matbot-host-node';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

// matbot as a dependency of someone else's Node application: a server that authenticates its own users and
// sets the principal per request, with a fixed set of plugins and no `plugin` tool. Built from core,
// host-node and a storage plugin's backend — which is the point. If a step this needs ever moves back into
// the CLI, this file can no longer be written without importing the app, and the check below says so.

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

test('this embedder imports nothing of the CLI app', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const sources = [...source.matchAll(/^import[^;]*?from '([^']+)'/gms)].map(m => m[1]!);
  assert.deepEqual(sources.filter(s => !/^(node:|@matatbread\/matbot-(core|host-node|storage-filesystem)$)/.test(s)), []);
});

// A provider adapter on disk, loaded by path like any other plugin: it calls `whoami`, then answers.
async function fixtureProvider(dir: string): Promise<string> {
  const pkg = join(dir, 'whoami-provider');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'whoami-provider', version: '1.0.0', type: 'module', matbotRuntime: ['node'], exports: './index.js',
  }));
  await writeFile(join(pkg, 'index.js'), `
    const adapter = {
      name: 'whoami-provider',
      async health() { return { ok: true }; },
      async *complete(messages) {
        const answered = messages.some(m => m.content.some(c => c.type === 'tool-result'));
        if (!answered) yield { type: 'tool-call', id: 'w0', name: 'whoami', input: {} };
        else           yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      },
    };
    export const plugin = { apiVersion: ${JSON.stringify(PLUGIN_API_VERSION)}, provider: () => adapter };
  `);
  return pkg;
}

test('a machine from core and host-node: per-request principals, a plugin by path, no plugin tool', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-embedder-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = await fixtureProvider(dir);

  installPrincipalCarrier(createAlsPrincipalCarrier());
  installUsageCarrier(createAlsUsageCarrier());

  const { services, loaded } = assembleMachine({
    bootBackend: new FilesystemStorageBackend(join(dir, '.data')),
    vault:       await EnvFileVault.open(join(dir, '.env')),
    providers:   new ProviderRegistryImpl([['p', { name: 'p', module: provider, model: 'm' }]]),
    version:     'embedded',
    host: machine => ({ ...nodePluginMembers(machine, appDir), isSubAgent: () => false }),
  });
  // A package by path: plain resolution, nothing fetched or installed.
  await services.loadPlugin('../../plugins/whoami');
  loaded();

  const names = services.tools.list().map(tool => tool.name);
  assert.ok(names.includes('whoami'), 'the plugin loaded');
  assert.ok(names.includes('gate_action'), 'with the default gate, though none was passed');
  assert.ok(!names.includes('plugin'), 'and no plugin tool, since none was');

  // Two requests at once, each under the principal its own authentication established.
  const alice: Principal = { id: 'alice', type: 'user' };
  const bob:   Principal = { id: 'bob',   type: 'user' };
  const ask = (p: Principal) => runAs(p, async () => {
    await new Promise(r => setTimeout(r, 5));
    return toolResult(invokeTool(services, 'whoami', {}, { session: createSession(), signal: new AbortController().signal }));
  });
  assert.deepEqual(await Promise.all([ask(alice), ask(bob)]), [alice, bob]);

  // A turn carries its submitter's principal into the tool it calls.
  const session = createSession();
  await services.sessions!.set(session.id, session);
  await runAs(bob, async () => {
    const view = await services.run!.open({
      sessionId: session.id, signal: new AbortController().signal, provider: 'p',
      principal: bob, content: [{ type: 'text', text: 'who am I?' }],
    });
    for await (const ev of view.events) if (ev.type === 'idle') break;
  });
  const results = (await services.sessions!.get(session.id))!.messages
    .flatMap(m => m.content).filter(c => c.type === 'tool-result');
  assert.equal(results.length, 1);
  assert.match(JSON.stringify(results[0]), /"id":"bob"/);
});
