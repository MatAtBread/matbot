import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, installSettingsDefaults } from '@matatbread/matbot-core';
import type { PromptFn } from '@matatbread/matbot-core';
import { collider, twinCollider, machine } from './fixtures/collision-harness.ts';

// Own file: the resolved policy is cached in module-global state, and this test is about what WRITING
// it does — a sibling test in the same file would find it already filled.

// The install already exempts a name of its own. Answering "always" for one more tool must not drop it:
// a stored key wins over the default wholesale, so the write has to carry the list in effect.
installSettingsDefaults(new Map([['__matbot_core__', { overwriteToolsOnCollision: ['already-exempt'] }]]));

test('"Always overwrite <tool>" adds that tool to the list, keeping what the install already exempted', async () => {
  const asked: string[] = [];
  const prompt = (async (f: { label: string; options?: string[] }) => {
    asked.push(f.label);
    const chosen = f.options?.find(o => o.startsWith('Always overwrite "'));
    assert.ok(chosen, 'the prompt offers a per-tool "always" option');
    return chosen;
  }) as PromptFn;
  const { services, tools, docs } = machine();

  await loadPlugins([{ spec: collider, importSpec: collider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1);
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool');
  const stored = docs.get('__matbot_core__') as { data: Record<string, unknown> } | undefined;
  assert.deepEqual(stored?.data['overwriteToolsOnCollision'], ['already-exempt', 'contested'],
    'the answer is persisted as the list in effect plus this tool, never as this tool alone');

  // And it takes effect: the next plugin to claim that name is not asked about.
  await loadPlugins([{ spec: twinCollider, importSpec: twinCollider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1, 'the same tool is not asked about twice');
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool-twin');
});
