import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookRegistry, createSession } from '@matatbread/matbot-core';

// A run loop iterates the channel's array across each handler's await. `register` used to push onto and
// sort THAT array in place, so a hook registered by a running handler joined the pass already under way
// — or, once the sort moved an earlier hook behind the cursor, ran the registrar again. A registrar that
// registers on every call therefore never finished the pass at all.

const ctx = () => ({
  outgoing: [],
  session:  createSession(),
  config:   { provider: 'fake', traceId: 't1' },
  signal:   new AbortController().signal,
});

test('a hook registered by a running handler waits for the next pass', async () => {
  const hooks = new HookRegistry();
  const ran: string[] = [];
  hooks.register({ on: 'contribute', priority: 10, handler: () => {
    ran.push('first');
    hooks.register({ on: 'contribute', priority: 90, handler: () => { ran.push('late'); } });
  } });

  await hooks.runContribute(ctx());
  assert.deepEqual(ran, ['first'], 'the pass in progress is over the list as it stood when it began');

  ran.length = 0;
  await hooks.runContribute(ctx());
  assert.deepEqual(ran.filter(r => r === 'late'), ['late'], 'and the next pass includes it');
});

test('registering a higher-priority hook mid-run does not re-run the one that registered it', async () => {
  const hooks = new HookRegistry();
  const ran: string[] = [];
  let registered = false;
  hooks.register({ on: 'contribute', priority: 50, handler: () => {
    ran.push('registrar');
    if (registered) return;
    registered = true;
    hooks.register({ on: 'contribute', priority: 10, handler: () => { ran.push('early'); } });
  } });
  hooks.register({ on: 'contribute', priority: 60, handler: () => { ran.push('after'); } });

  await hooks.runContribute(ctx());
  assert.deepEqual(ran, ['registrar', 'after']);
});
