import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAboutMatbotTool, SystemContextRegistryImpl } from '@matatbread/matbot-core';
import type { MatbotMachine, Session, ToolContext } from '@matatbread/matbot-plugin-api';

// `about_matbot` is what the model reaches for when asked "what are you running?" — and the system
// prompt is the largest part of that answer it could not otherwise see. It is assembled once per submit
// and never persisted, so there is nothing on the session to read back: the tool rebuilds it, and the
// breakdown it reports has to be the same traversal that produced the text, or the two drift and the
// attribution starts naming the wrong plugin.

const session = { id: 's1', version: 'v1', messages: [], createdAt: '', updatedAt: '' } as unknown as Session;

function ctx(): ToolContext {
  return { callId: 'c1', session, signal: new AbortController().signal } as unknown as ToolContext;
}

async function run(reg: SystemContextRegistryImpl, provider?: string) {
  const tool = createAboutMatbotTool('9.9.9', { systemContext: reg } as unknown as MatbotMachine);
  const base = ctx() as ToolContext & { provider?: string };
  if (provider !== undefined) base.provider = provider;
  for await (const ev of tool.executor.execute({}, base)) {
    if (ev.type === 'result') return ev.value;
  }
  throw new Error('no result');
}

test('the reported prompt is exactly the joined parts, attributed to the plugins that wrote them', async () => {
  const reg = new SystemContextRegistryImpl();
  reg.register(() => 'skills catalogue', 'skills');
  reg.register(() => 'prefer a lambda', 'function-tools');

  const value = await run(reg, 'claude-sonnet-4-6');

  assert.equal(value.version, '9.9.9');
  assert.equal(value.currentProvider, 'claude-sonnet-4-6');
  assert.deepEqual(value.systemContext, [
    { text: 'skills catalogue', plugin: 'skills' },
    { text: 'prefer a lambda',  plugin: 'function-tools' },
  ]);
  // The same separator the registry uses for the wire, so what is reported is what was sent.
  assert.equal(value.systemPrompt, 'skills catalogue\n\nprefer a lambda');
  assert.equal(value.systemPrompt, await reg.build({ session, signal: new AbortController().signal }));
});

test('a contributor that declines contributes nothing, and no contributor at all is null rather than empty', async () => {
  const reg = new SystemContextRegistryImpl();
  reg.register(() => null, 'skills');          // has nothing to say this turn
  reg.register(() => '',   'triggers');        // said nothing, which is the same thing
  reg.register(async () => 'the only line');   // no plugin name: registered outside the plugin facade

  const value = await run(reg);

  assert.deepEqual(value.systemContext, [{ text: 'the only line' }]);
  assert.equal(value.systemPrompt, 'the only line');

  const empty = await run(new SystemContextRegistryImpl());
  assert.equal(empty.systemPrompt, null, 'no system message at all must read as null, not ""');
  assert.deepEqual(empty.systemContext, []);
});

test('an unloaded plugin stops appearing in the breakdown', async () => {
  const reg = new SystemContextRegistryImpl();
  reg.register(() => 'from skills', 'skills');
  reg.register(() => 'from cognition', 'cognition');
  reg.removeByPlugin('skills');

  assert.deepEqual((await run(reg)).systemContext, [{ text: 'from cognition', plugin: 'cognition' }]);
});
