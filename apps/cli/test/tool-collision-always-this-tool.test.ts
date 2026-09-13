import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, installSettingsDefaults, makePluginSettings, slugSettingsNamespace } from '@matatbread/matbot-core';
import type { PromptFn, SettingsDoc, Store } from '@matatbread/matbot-core';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS } from '@matatbread/matbot-default-gate';
import { collider, twinCollider, machine } from './fixtures/collision-harness.ts';

// Own file: this is about what ANSWERING "always" writes, and a sibling test in the same file would
// find the answer already written (the plugin registry, and hence the load path, is module-global).

// The install already exempts a subject of its own. Answering "always" for one more must not drop it:
// a stored key wins over the default wholesale, so the write has to carry the list in effect.
installSettingsDefaults(new Map([[DEFAULT_GATE_SETTINGS_NS, { 'tools.overwrite': ['already-exempt'] }]]));

test('"Always allow <subject>" adds it to the list, keeping what the install already exempted', async () => {
  const asked: string[] = [];
  const prompt = (async (f: { label: string; options?: string[] }) => {
    asked.push(f.label);
    const chosen = f.options?.find(o => o.startsWith('Always allow "'));
    assert.ok(chosen, 'the prompt offers a per-subject "always" option');
    return chosen;
  }) as PromptFn;
  const { services, tools, docs } = machine(settings =>
    createDefaultGate(makePluginSettings(settings as unknown as Store<SettingsDoc>, DEFAULT_GATE_SETTINGS_NS)));

  await loadPlugins([{ spec: collider, importSpec: collider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1);
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool');
  const stored = docs.get(slugSettingsNamespace(DEFAULT_GATE_SETTINGS_NS)) as { data: Record<string, unknown> } | undefined;
  assert.deepEqual(stored?.data['tools.overwrite'], ['already-exempt', 'contested'],
    'the answer is persisted as the list in effect plus this subject, never as this subject alone');
  assert.deepEqual(stored?.data['__gates__'], ['tools.overwrite'],
    'and the gate id is indexed, so gate_action can report and clear an answer for an id it never compiled against');

  // And it takes effect: the next plugin to claim that name is not asked about.
  await loadPlugins([{ spec: twinCollider, importSpec: twinCollider }], services, false, prompt, 'skip');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(asked.length, 1, 'the same subject is not asked about twice');
  assert.equal(tools.get('contested')?.pluginName, 'collides-tool-twin');
});
