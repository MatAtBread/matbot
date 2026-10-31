import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  loadPlugins, unloadPlugin,
} from '@matatbread/matbot-core';
import type { Vault } from '@matatbread/matbot-core';
import type { Triggers } from '@matatbread/matbot-triggers';
import { createAlsUsageCarrier } from '../src/usage-als.js';
import { defaultGate } from '@matatbread/matbot-core';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

// cognition seeds its skills and triggers once a SkillManager is present, and read `Triggers` only at
// that moment. So with `triggers` listed AFTER `cognition`, nothing was ever seeded — at that boot or
// any later one, since the order is the same each time — and the Inner voice never fired.

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

const entry = (dir: string) => new URL(`../../../plugins/${dir}/src/index.ts`, import.meta.url).href;

for (const order of [['triggers', 'skills', 'cognition'], ['skills', 'cognition', 'triggers']]) {
  test(`cognition seeds its triggers with plugins loaded as ${order.join(', ')}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'matbot-cognition-'));
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
    const loaded = await loadPlugins(order.map(p => ({ spec: entry(p), importSpec: entry(p), name: `@matatbread/matbot-${p}` })), services, false, undefined, 'skip');
    t.after(async () => { for (const p of loaded.reverse()) await unloadPlugin(p.name, services); await rm(dir, { recursive: true, force: true }); });
    assert.equal(loaded.length, 3);

    const triggers = (services as unknown as { Triggers: Triggers }).Triggers;
    let seeded = 0;
    for (let i = 0; i < 100 && seeded === 0; i++) {
      await new Promise(r => setTimeout(r, 20));
      seeded = (await triggers.query({ tool: 'remember_fact' })).length;
    }
    assert.equal(seeded, 1, 'exactly one remember_fact trigger is seeded, whatever the order');
  });
}
