import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  loadPlugins, unloadPlugin, TOOL_INPUT_INVALID,
} from '@matatbread/matbot-core';
import type { Vault, MatbotMachine, Tool, ToolEvent, ToolInputError } from '@matatbread/matbot-core';
import { createAlsUsageCarrier } from '../src/usage-als.js';
import { defaultGate } from '@matatbread/matbot-default-gate';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

// Validators are `validate` hooks: several co-exist with no reference to one another, every one is asked,
// and a call is refused if any refuses it. They were one `ToolCallValidator` service, which made the
// second capture the first and delegate to it — so the pair depended on load order and on each other.

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

const answers = ((globalThis as Record<string, unknown>)['__validates'] ??= {}) as Record<string, () => ToolInputError[] | undefined>;
let seq = 0;

async function machine(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { services } = assembleMachine({
    bootBackend: new FilesystemStorageBackend(dir),
    vault:       { resolve: async (r: string) => r } as unknown as Vault,
    providers:   new ProviderRegistryImpl(new Map()),
    gate:        defaultGate,
    version:     '0',
    host: () => ({
      loadPlugin:   async () => { throw new Error('unused'); },
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: (s: string) => s },
    }),
  });
  const calls: unknown[] = [];
  services.tools.register({
    name: 'thing', description: '', inputSchema: { type: 'object' },
    executor: { async *execute(input) { calls.push(input); yield { type: 'result', value: 'ran' }; } },
  } as Tool);
  return { services, calls };
}

// Load validators in the given order; each answers as `answers[name]` says. Returns plugin names by validator.
async function validators(services: MatbotMachine, which: Record<string, () => ToolInputError[] | undefined>): Promise<Record<string, string>> {
  const run = ++seq;
  const names: Record<string, string> = {};
  const reqs = Object.entries(which).map(([v, answer]) => {
    const as = `${v}-${run}`;
    answers[as] = answer;
    const url = new URL(`./fixtures/validates.ts?as=${as}`, import.meta.url).href;
    names[v] = `validates-${as}`;
    return { spec: url, importSpec: url, name: names[v]! };
  });
  assert.equal((await loadPlugins(reqs, services, false, undefined, 'skip')).length, reqs.length);
  return names;
}

async function call(services: MatbotMachine): Promise<ToolEvent[]> {
  const out: ToolEvent[] = [];
  for await (const ev of services.tools.resolve('thing')!.executor.execute({ x: 1 }, { signal: new AbortController().signal } as never)) out.push(ev);
  return out;
}

const SCHEMA_SAYS = [{ path: '.x', message: 'expected string' }];
const TYPE_SAYS   = [{ path: '.y', message: 'required property missing' }];

for (const order of [['schema', 'typed'], ['typed', 'schema']] as const) {
  test(`a call either validator refuses is refused, loaded ${order.join(' then ')}`, async t => {
    const { services, calls } = await machine(t);
    const say = { schema: () => SCHEMA_SAYS, typed: () => [] as ToolInputError[] };
    await validators(services, Object.fromEntries(order.map(v => [v, say[v]])));

    const [ev] = await call(services);
    assert.ok(ev?.type === 'error' && ev.code === TOOL_INPUT_INVALID && ev.message.includes('.x: expected string'));
    assert.deepEqual(calls, [], 'the tool did not run');
  });
}

test('every refusal is reported, and an error two validators share is said once', async t => {
  const { services } = await machine(t);
  await validators(services, { schema: () => [...SCHEMA_SAYS, ...TYPE_SAYS], typed: () => TYPE_SAYS });
  assert.deepEqual(await services.tools.validate!('thing', {}), [...SCHEMA_SAYS, ...TYPE_SAYS]);
});

test('no opinion from any validator lets the call through; `[]` from one says it is valid', async t => {
  const { services, calls } = await machine(t);
  await validators(services, { schema: () => undefined, typed: () => undefined });
  assert.equal(await services.tools.validate!('thing', {}), undefined);
  assert.deepEqual(await call(services), [{ type: 'result', value: 'ran' }]);

  await validators(services, { other: () => [] });
  assert.deepEqual(await services.tools.validate!('thing', {}), []);
  assert.equal(calls.length, 1);
});

test('unloading a validator removes its opinion and nothing else', async t => {
  const { services } = await machine(t);
  const names = await validators(services, { schema: () => SCHEMA_SAYS, typed: () => TYPE_SAYS });

  await unloadPlugin(names['schema']!, services);
  assert.deepEqual(await services.tools.validate!('thing', {}), TYPE_SAYS, 'the other one still answers');

  await unloadPlugin(names['typed']!, services);
  assert.equal(await services.tools.validate!('thing', {}), undefined, 'and with both gone, nothing validates');
});

test('a validator that throws is no opinion, not a refusal', async t => {
  const { services } = await machine(t);
  await validators(services, { broken: () => { throw new Error('boom'); }, typed: () => [] });
  assert.deepEqual(await services.tools.validate!('thing', {}), []);
});
