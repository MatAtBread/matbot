import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, installSettingsDefaults, makePluginSettings } from '@matatbread/matbot-core';
import type { PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS } from '@matatbread/matbot-default-gate';
import { collider, otherCollider, machine } from './fixtures/collision-harness.ts';

// The policy is the default-gate plugin's, out of ITS settings namespace — core holds none of this any
// more, and the key it used to hold (`__matbot_core__.overwriteToolsOnCollision`) is deliberately not
// migrated. Both tests here want the same floor, so it is installed once.
installSettingsDefaults(new Map([[DEFAULT_GATE_SETTINGS_NS, { 'tools.overwrite': ['contested'] }]]));
after(() => { installSettingsDefaults(undefined); });

const gate = (settings: Store<never>) =>
  createDefaultGate(makePluginSettings(settings as unknown as Store<SettingsDoc>, DEFAULT_GATE_SETTINGS_NS));

// Answering "Deny" makes both assertions falsifiable: the listed tool changes hands only if the prompt
// was skipped, and the unlisted one survives only if it was consulted.
function recordingPrompt(): { asked: string[]; prompt: PromptFn } {
  const asked: string[] = [];
  const prompt = (async (f: { label: string }) => { asked.push(f.label); return 'Deny'; }) as PromptFn;
  return { asked, prompt };
}

test('a subject the policy already allows overwrites without prompting', async () => {
  const { asked, prompt } = recordingPrompt();
  const { services, tools } = machine(gate);

  await loadPlugins([{ spec: collider, importSpec: collider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(asked, [], 'an allowed subject must not be prompted for');
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool',
    'a standing allow resolves the way the answer it stands in for did — overwrite');
});

test('a list is not a blanket true: a subject it does not name is still prompted for', async () => {
  const { asked, prompt } = recordingPrompt();
  const { services, tools } = machine(gate);

  await loadPlugins([{ spec: otherCollider, importSpec: otherCollider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1, 'an unlisted collision still asks');
  assert.equal(tools.get('other-contested')?.pluginName, 'the-incumbent', 'and the answer is honoured');
});
