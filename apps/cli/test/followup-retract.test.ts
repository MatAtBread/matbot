import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookRegistry, createSession } from '@matatbread/matbot-core';
import type { MessageContent } from '@matatbread/matbot-core';

// `retractAndRerun` has two optional fields, so `{}` is type-legal — and the registry decided whether a
// retract had been requested by measuring the PAYLOAD (`context.length || durable.length`). A hook asking
// to pop the turn and re-run it with nothing added was therefore answered by doing nothing at all: no
// pop, no redo, no diagnostic. The request's presence is the request.

const ctx = () => ({
  session:       createSession(),
  resubmitDepth: 0,
  config:        { provider: 'fake', traceId: 't1' },
  signal:        new AbortController().signal,
});

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('a retract request with no payload still retracts', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'followup', pluginName: 'retractor', handler: () => ({ retractAndRerun: {} }) });

  const r = await hooks.runFollowup(ctx());
  assert.ok(r.retract, 'the pop was asked for, so it is reported');
  assert.deepEqual(r.retract.context, [], 'with nothing to inject');
  assert.deepEqual(r.retract.durable, []);
});

test('no retract request means no retract', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'followup', pluginName: 'quiet', handler: () => ({ markers: text('just tracing') }) });

  assert.equal((await hooks.runFollowup(ctx())).retract, undefined);
});

test('several hooks retracting merge into one pop', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'followup', pluginName: 'a', handler: () => ({ retractAndRerun: { context: text('one') } }) });
  hooks.register({ on: 'followup', pluginName: 'b', handler: () => ({ retractAndRerun: { durable: text('two') } }) });

  const r = await hooks.runFollowup(ctx());
  assert.ok(r.retract, 'a turn can only be popped once');
  assert.deepEqual(r.retract.context.map(c => c.type === 'text' && c.text), ['one']);
  assert.deepEqual(r.retract.durable.map(c => c.type === 'text' && c.text), ['two']);
});
