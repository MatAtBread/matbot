import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, installSettingsDefaults } from '@matatbread/matbot-core';
import type { PromptFn } from '@matatbread/matbot-core';
import { collider, otherCollider, machine } from './fixtures/collision-harness.ts';

// Own file for the reason the harness states: the resolved policy is cached in module-global state.
// Both tests here want the same policy, so it is installed once — clearing it between them would only
// prove that the cache had already been filled.
installSettingsDefaults(new Map([['__matbot_core__', { overwriteToolsOnCollision: ['contested'] }]]));
after(() => { installSettingsDefaults(undefined); });

// Answering "Keep existing" makes both assertions falsifiable: the listed tool changes hands only if
// the prompt was skipped, and the unlisted one survives only if it was consulted.
function recordingPrompt(): { asked: string[]; prompt: PromptFn } {
  const asked: string[] = [];
  const prompt = (async (f: { label: string }) => { asked.push(f.label); return 'Keep existing'; }) as PromptFn;
  return { asked, prompt };
}

test('a tool named by overwriteToolsOnCollision overwrites without prompting', async () => {
  const { asked, prompt } = recordingPrompt();
  const { services, tools } = machine();

  await loadPlugins([{ spec: collider, importSpec: collider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(asked, [], 'a listed tool must not be prompted for');
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool',
    'not asking resolves the way the prompt default does — overwrite');
});

test('a list is not a blanket true: a tool it does not name is still prompted for', async () => {
  const { asked, prompt } = recordingPrompt();
  const { services, tools } = machine();

  await loadPlugins([{ spec: otherCollider, importSpec: otherCollider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1, 'an unlisted collision still asks');
  assert.equal(tools.get('other-contested')?.pluginName, 'the-incumbent', 'and the answer is honoured');
});
