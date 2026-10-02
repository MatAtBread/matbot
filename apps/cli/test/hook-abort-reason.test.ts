import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookRegistry, createSession } from '@matatbread/matbot-core';

// A steer aborts the running turn with the reason 'steer', and anything awaiting the turn's signal — a
// followup classifier, say — rejects with that bare string. The hook runner used to log it as a failure
// whose entire message was "steer", and leave a durable failure marker in the session for it. A hook cut
// off by its turn's abort was not broken; a hook that genuinely throws should be logged with its stack.

const ctx = (signal: AbortSignal) => ({
  outgoing: [],
  session:  createSession(),
  config:   { provider: 'fake', traceId: 't1' },
  signal,
});

async function captured<T>(fn: () => Promise<T>): Promise<{ warn: unknown[][]; error: unknown[][] }> {
  const warn: unknown[][] = [];
  const error: unknown[][] = [];
  const [w, e] = [console.warn, console.error];
  console.warn  = (...a: unknown[]) => { warn.push(a); };
  console.error = (...a: unknown[]) => { error.push(a); };
  try { await fn(); } finally { [console.warn, console.error] = [w, e]; }
  return { warn, error };
}

// Failure markers are drained into the session by the next screen pass.
async function markers(hooks: HookRegistry): Promise<unknown[]> {
  const r = await hooks.runScreen({ session: createSession(), config: { provider: 'fake', traceId: 't2' }, signal: new AbortController().signal });
  return r.markers.map(m => (m as { data: unknown }).data);
}

test('a hook cut off by its turn\'s abort is reported as cut off, with no failure marker', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'contribute', pluginName: 'p', handler: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });

  const ac = new AbortController();
  const log = await captured(async () => {
    const run = hooks.runContribute(ctx(ac.signal));
    ac.abort('steer');
    await run;
  });

  assert.equal(log.error.length, 0, 'not logged as a failure');
  assert.match(String(log.warn[0]?.[0]), /contribute hook from "p" was cut off: its turn was aborted \(reason: "steer"\)/);
  assert.deepEqual(await markers(hooks), [], 'and nothing durable is left in the session for it');
});

// `aborted` stays true for the rest of the turn, so "the signal is aborted" is not the same question as
// "this throw was the abort". Asking the first masked every genuine hook failure from the first steer
// onwards — and interrupt is the default disposition for a mid-turn message, so that is the common case.
test('a hook that throws its own fault DURING an aborted turn is still reported and marked', async () => {
  const hooks = new HookRegistry();
  const bug = new TypeError('cannot read properties of undefined');
  hooks.register({ on: 'followup', pluginName: 'p', handler: () => { throw bug; } });

  const ac = new AbortController();
  ac.abort('steer');
  const log = await captured(() => hooks.runFollowup({
    session: createSession(), config: { provider: 'fake', traceId: 't1' }, signal: ac.signal,
  } as never));

  assert.equal(log.warn.length, 0, 'not excused as a cut-off just because the turn was aborted');
  assert.equal(log.error[0]?.[1], bug, 'the Error itself, so the stack survives');
  assert.deepEqual(await markers(hooks), [{ channel: 'followup', pluginName: 'p', message: bug.message }]);
});

// The other shape a cut-off arrives in: a helper that rejects with a DOMException rather than the reason.
test('a hook cut off with an AbortError is a cut-off too, not a failure', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'contribute', pluginName: 'p', handler: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });

  const ac = new AbortController();
  const log = await captured(async () => {
    const run = hooks.runContribute(ctx(ac.signal));
    ac.abort('user-cancel');
    await run;
  });

  assert.equal(log.error.length, 0);
  assert.match(String(log.warn[0]?.[0]), /was cut off/);
  assert.deepEqual(await markers(hooks), []);
});

test('a hook that genuinely throws is logged with the Error, so the stack survives, and marked', async () => {
  const hooks = new HookRegistry();
  const boom = new Error('boom');
  hooks.register({ on: 'contribute', pluginName: 'p', handler: () => { throw boom; } });

  const log = await captured(() => hooks.runContribute(ctx(new AbortController().signal)));

  assert.equal(log.error[0]?.[1], boom, 'the Error itself, not just its message');
  assert.deepEqual(await markers(hooks), [{ channel: 'contribute', pluginName: 'p', message: 'boom' }]);
});

test('a non-Error throw outside any abort says that is what it was', async () => {
  const hooks = new HookRegistry();
  hooks.register({ on: 'contribute', pluginName: 'p', handler: () => { throw 'oops'; } });

  const log = await captured(() => hooks.runContribute(ctx(new AbortController().signal)));

  assert.equal(log.error[0]?.[1], 'threw a non-Error value: "oops"');
  assert.deepEqual(await markers(hooks), [{ channel: 'contribute', pluginName: 'p', message: 'threw a non-Error value: "oops"' }]);
});
