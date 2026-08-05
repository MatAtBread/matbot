import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, promptCancelledError } from '@matatbread/matbot-core';
import type { PromptFn } from '@matatbread/matbot-core';
import { collider, machine } from './fixtures/collision-harness.ts';

// `ToolRegistry.register` returns `void` because the no-collision path completes in the calling tick,
// and all ~34 call sites in the repo fire-and-forget. That leaves the collision branch as the one await
// with no caller to own its outcome: a throw there was an unhandled rejection — process exit under
// Node's default — reached by the ordinary act of two plugins claiming one tool name.
test('a rejecting prompt resolves the collision to keep-existing instead of crashing the process', async () => {
  // A PromptFn that rejects is the non-interactive contract (PromptCancelledError), not a bug — and
  // nothing awaits registerTool, so before the fix this rejection had no handler at all.
  const rejecting: PromptFn = (() => Promise.reject(promptCancelledError())) as PromptFn;
  const { services, tools } = machine();

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const loaded = await loadPlugins([{ spec: collider, importSpec: collider }], services, false, rejecting, 'skip');
    assert.equal(loaded.length, 1, 'the collision must not fail the load');
    // Let the detached collision branch settle, and any unhandled rejection surface.
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], 'the collision branch must own its own failure');
    assert.equal(tools.get('contested')?.pluginName, 'the-incumbent', 'a failure to resolve keeps the existing tool');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
