import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import type { ToolValidatorSupplier } from '@matatbread/matbot-tool-types';
import type { MatbotMachine, Tool } from '@matatbread/matbot-plugin-api';

// Building the index is a TypeScript Program, made synchronously on the main thread: about 2 s on a
// one-CPU host. Its callers are independent — ts-validation on the first tool call, a turn start asking
// for the wire contracts — so they meet, and each used to start a build of its own. A config dir with
// nothing to scan keeps a build cheap; what is counted is how many START, each reading the live tool
// list once. Each test is bounded: a guard that never lets go would otherwise hang the suite rather
// than fail it.
const bounded = { timeout: 10_000 };

async function index(opts: { failFirstBuild?: boolean } = {}) {
  let reads = 0;
  let changed: () => void = () => { throw new Error('the index never subscribed to registry changes'); };
  let registered: unknown;
  const machine = {
    configPath: join(mkdtempSync(join(tmpdir(), 'tool-types-')), 'matbot.yaml'),
    Notifier: {
      consume: (onChange: () => void) => { changed = onChange; },
      notify: () => {},
      subscribe: () => (async function* () {})(),
    },
    tools: {
      list: (): Tool[] => {
        reads++;
        if (opts.failFirstBuild && reads === 1) throw new Error('registry unavailable');
        return [];
      },
      resolve: () => null,
      register() {}, remove() {}, removeByPlugin() {},
    },
    register: async (_key: string, value: unknown) => { registered = value; },
  } as unknown as MatbotMachine;
  await createToolTypesPlugin().setup?.(machine);
  return {
    index: registered as ToolValidatorSupplier,
    builds: () => reads,
    registryChanged: () => changed(),
  };
}

test('callers that arrive while the index is building share that one build', bounded, async () => {
  const { index: idx, builds } = await index();
  const [a, b, c] = await Promise.all([idx.toolValidators(), idx.toolValidators(), idx.toolValidators()]);
  assert.equal(builds(), 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a tool registered during a build is not lost: the next caller rebuilds', bounded, async () => {
  const { index: idx, builds, registryChanged } = await index();
  const underWay = idx.toolValidators();
  registryChanged();
  await underWay;
  assert.equal(builds(), 1, 'the caller from before the change keeps the build it started');
  await idx.toolValidators();
  assert.equal(builds(), 2, 'the change marked that build stale');
});

test('a caller after a registry change does not take a build from before it', bounded, async () => {
  const { index: idx, builds, registryChanged } = await index();
  const before = idx.toolValidators();
  registryChanged();
  const after = idx.toolValidators();
  const [old, fresh] = await Promise.all([before, after]);
  assert.equal(builds(), 2);
  assert.notEqual(old, fresh);
});

test('a build that fails is not kept: the next caller builds again', bounded, async () => {
  const { index: idx, builds } = await index({ failFirstBuild: true });
  await assert.rejects(idx.toolValidators(), /registry unavailable/);
  await idx.toolValidators();
  assert.equal(builds(), 2);
});
