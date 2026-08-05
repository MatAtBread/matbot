import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, unloadPlugin } from '@matatbread/matbot-core';
import type { PromptFn } from '@matatbread/matbot-core';
import { collider, machine } from './fixtures/collision-harness.ts';

// The other end of the same fire-and-forget window: setup() has already returned by the time a slow
// collision resolves, so an unload — or a setup() throw and its rollback — can land first, and
// registering then would revive a tool owned by a plugin that is gone.
test('a collision resolving after the plugin unloaded does not revive its tool', async () => {
  // A real interactive prompt is slow — the user is thinking. `Overwrite`, not `Always overwrite`: the
  // latter persists into module-global state, which is what the file split exists to keep out of here.
  let release = (): void => {};
  const gate = new Promise<void>(r => { release = r; });
  const slow: PromptFn = (async () => { await gate; return 'Overwrite'; }) as PromptFn;
  const { services, tools } = machine();

  await loadPlugins([{ spec: collider, importSpec: collider }], services, false, slow, 'skip');
  await unloadPlugin('collides-tool', services);
  release();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(tools.get('contested')?.pluginName, 'the-incumbent', 'the unloaded plugin must not win the name after the fact');
});
