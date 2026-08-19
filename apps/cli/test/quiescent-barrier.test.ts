import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onContextQuiesce, flushIfQuiescent, machineBusy, quiesced, scheduleAtEdge } from '@matatbread/matbot-core';

// The quiescent edge used to be a COUNTER: `machineBusy` incremented, ran, decremented, and a flush
// happened only if it found the count at zero. Nothing forced it to zero. So under continuously
// overlapping holds — several sessions on a busy server, each pump holding across its own queue — the
// count never touched zero and staged work waited for an idle moment that never came: a deferred session
// edit that never lands, a staged StorageBackend swap that never applies. Both are failures with no
// symptom at all, which is why no test caught it.
//
// It is now a barrier: staged work that cannot land raises `wanted`, and new entrants are turned away
// until the machine drains and the flush runs. Exclusivity for an async flusher falls out of that for
// free — and it is what makes the flusher's view of "the machine is quiet" true for its whole extent
// rather than at the instant it was invoked.
//
// Correctness never depended on this (mediumGuard fails a write whose read came from another backend, on
// the version stamp). Liveness did.

/**
 * A hold that stays up until `release()` is called. The indirection matters: an entrant turned away at
 * the barrier has not run its body yet, so its resolver does not exist at the time this returns — and
 * calling a captured no-op instead would abandon the hold, which wedges the machine for good.
 */
function openHold(body?: () => void): { done: Promise<unknown>; release: () => void } {
  let resolve: (() => void) | undefined;
  const done = machineBusy(() => new Promise<void>(r => { resolve = r; body?.(); }));
  return { done, release: () => resolve?.() };
}

test('staged work lands while holds are still overlapping', { timeout: 15000 }, async () => {
  await quiesced();

  let landed = 0;
  let pending = false;
  const un = onContextQuiesce(() => { if (pending) { pending = false; landed++; } });

  try {
    // Stage from INSIDE a hold — staged while idle it would land inline, and prove nothing.
    let cur = openHold(() => { pending = true; flushIfQuiescent(); });
    await Promise.resolve();
    assert.equal(landed, 0, 'it cannot have landed yet: this hold is what is in the way');

    // Now keep entrants arriving and never let the machine go unheld between one and the next — the
    // interleaving a busy multi-session server produces, and the one a counter never sees the bottom of.
    // The assertion is made mid-chain, with holds still overlapping, because that is the whole question:
    // a counter lands this work only once the traffic finally stops.
    for (let i = 0; i < 6; i++) {
      const next = openHold();
      cur.release();
      await cur.done;
      cur = next;
      if (landed > 0) break;
    }
    assert.equal(landed, 1, 'the barrier forced a drain even though holds never stopped overlapping');

    cur.release();
    await cur.done;
  } finally {
    un();
  }
});

test('an async flusher runs with the machine to itself', { timeout: 15000 }, async () => {
  await quiesced();

  // Exclusivity is the property a counter could not provide and the docs used to say was impossible: the
  // count sat at zero while a flush settled, so anything could enter inside a single `await`. A flusher
  // that reads a document, thinks, and writes it back was exposed for its whole middle.
  const order: string[] = [];
  let pending = false;
  const un = onContextQuiesce(async () => {
    if (!pending) return;                       // idempotent: the edge is reached after every operation
    pending = false;
    order.push('flush:start');
    await new Promise(r => setTimeout(r, 30));
    order.push('flush:end');
  });

  try {
    // Stage while held, so the flush begins at this hold's release rather than inline — leaving it in
    // flight, which is the only moment exclusivity is a question at all.
    await machineBusy(async () => {
      pending = true;
      flushIfQuiescent();
      order.push('holder:done');
    });

    // The flush is now mid-`await`. Under the old counter, depth was 0 here and this walked straight in,
    // landing between the flusher's read and its write — 'entrant' would sit between start and end.
    await machineBusy(() => { order.push('entrant'); });

    assert.deepEqual(order, ['holder:done', 'flush:start', 'flush:end', 'entrant'],
      'an entrant must not run inside the flusher\'s await');
  } finally {
    un();
  }
});

test('a flusher that cannot be satisfied does not wedge the machine', { timeout: 20000 }, async () => {
  await quiesced();

  // A counter cannot tell a nested entrant from a concurrent one, so an operation that holds the machine
  // and then waits on something needing the edge would wait for a drain including its own hold. Rather
  // than a hold-identity carrier (AsyncLocalStorage, and a browser equivalent) the barrier is BOUNDED: it
  // gives up, warns, and proceeds — degrading to exactly the pre-barrier behaviour instead of hanging.
  let pending = false;
  const un = onContextQuiesce(() => { if (pending) { /* never clears it */ } });

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };

  try {
    // Hold the machine, and from inside it enter again with work outstanding — the nested shape. The
    // inner entry cannot possibly be admitted, because the drain it waits for includes the outer hold.
    const started = Date.now();
    await machineBusy(async () => {
      pending = true;
      flushIfQuiescent();
      await machineBusy(() => { /* nested: only reachable because the wait is bounded */ });
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 2000, `it really did wait for the bound before giving up (waited ${elapsed}ms)`);
    assert.ok(elapsed < 15000, `and gave up rather than hanging (waited ${elapsed}ms)`);
    assert.ok(warnings.some(w => /entering the machine after waiting/.test(w)),
      `giving up must be diagnosable, not silent: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = realWarn;
    un();
  }
});

test('an ordinary entry pays nothing when no work is staged', async () => {
  await quiesced();

  // The barrier must be invisible on the hot path — every turn enters through here.
  const un = onContextQuiesce(() => { /* nothing pending, ever */ });
  try {
    const started = Date.now();
    for (let i = 0; i < 50; i++) await machineBusy(() => i);
    assert.ok(Date.now() - started < 500, 'entry is not paying a barrier cost when nothing is staged');
  } finally {
    un();
  }
});

test('work staged while a flush is settling still lands, with nothing else arriving', { timeout: 15000 }, async () => {
  await quiesced();

  // The awkward case: `depth` is already 0 (a flush is merely settling), so announcing raises no hold to
  // wait on and nothing is coming to force another edge. On an idle process the work would sit staged
  // indefinitely — the same starvation, reached from the other side. The settling flush answers it on the
  // way out, guarded on `wanted` so an idempotent async flusher cannot manufacture an endless chain.
  const landed: string[] = [];
  let queued: string | undefined;
  const un = onContextQuiesce(async () => {
    const work = queued;
    if (work === undefined) return;
    queued = undefined;
    await new Promise(r => setTimeout(r, 20));
    landed.push(work);
  });

  try {
    queued = 'first';
    const settling = flushIfQuiescent();
    assert.ok(settling, 'the flusher went async, so this edge is settling');

    // Announced mid-settle, and then NOTHING else touches the machine: no entrant, no release.
    queued = 'second';
    flushIfQuiescent();

    await settling;
    // Only timers from here — no quiesced(), no machineBusy, nothing that would itself supply the edge
    // this test is asserting the settle provides. (An earlier version awaited quiesced() here to give the
    // re-sweep time, and that call WAS the missing edge, so the test passed with the fix removed.)
    await new Promise(r => setTimeout(r, 80));

    assert.deepEqual(landed, ['first', 'second'], 'both landed without any further activity');
  } finally {
    un();
  }
});

test('a one-shot lands under continuous overlap without announcing anything itself', { timeout: 15000 }, async () => {
  await quiesced();

  // `defer()` in edit-session is exactly this shape — register a one-shot, never call flushIfQuiescent —
  // and it is the deferred session edit whose starvation motivated the barrier in the first place. While
  // announcing was a separate call, the barrier never engaged for it: the work landed only because the pump
  // happened to release, and under overlap it would have starved exactly as before. Registering announces
  // now, so the shape that reads as obviously correct IS correct.
  let landed = 0;

  // Register from inside a hold, then keep entrants arriving without ever leaving the machine unheld.
  let cur = openHold(() => { onContextQuiesce(un => { un(); landed++; }); });
  await Promise.resolve();
  assert.equal(landed, 0, 'the hold it was registered under is in the way');

  for (let i = 0; i < 6; i++) {
    const next = openHold();
    cur.release();
    await cur.done;
    cur = next;
    if (landed > 0) break;
  }
  assert.equal(landed, 1, 'a one-shot forced its own edge with no explicit announcement');

  cur.release();
  await cur.done;
});

test('a one-shot registered on an idle machine still runs, and exactly once', async () => {
  await quiesced();

  let ran = 0;
  onContextQuiesce(un => { un(); ran++; });
  assert.equal(ran, 0, 'not inline: a callback must not run before the statement registering it returns');

  await new Promise(r => setTimeout(r, 5));
  assert.equal(ran, 1, 'the microtask attempt found the machine idle and ran it');

  await machineBusy(() => {});
  await quiesced();
  assert.equal(ran, 1, 'and it unregistered itself, so later edges do not re-run it');
});

test('scheduleAtEdge coalesces repeated stagings into one apply', { timeout: 15000 }, async () => {
  await quiesced();

  // A host's announcements are usually about a SLOT, not a queue: three register('StorageBackend') calls
  // before an edge mean one backend to install. A plain one-shot per call would install three in turn and
  // announce up to three remounts; the guard collapses them, and reading the slot inside the work is what
  // makes the last writer win.
  const applied: string[] = [];
  let slot: string | undefined;
  const schedule = scheduleAtEdge(() => { applied.push(slot!); });

  await machineBusy(async () => {
    slot = 'a'; schedule();
    slot = 'b'; schedule();
    slot = 'c'; schedule();
  });

  assert.deepEqual(applied, ['c'], 'three stagings, one apply, and the last one wins');

  // And it re-arms: the guard is not a one-time latch.
  await machineBusy(async () => { slot = 'd'; schedule(); });
  assert.deepEqual(applied, ['c', 'd']);
});

test('scheduleAtEdge does not re-enter the edge from inside its own work', { timeout: 15000 }, async () => {
  await quiesced();

  // Registering announces, so a callback that re-registered itself would announce fresh work from inside the
  // sweep answering the last lot — and the edge would re-enter immediately and forever. There is no
  // independent clock to wait for, so re-registration is unbounded demand. The guard resets BEFORE the work
  // runs precisely so work may schedule again legitimately; what must not happen is a self-sustaining chain.
  let runs = 0;
  const schedule = scheduleAtEdge(() => {
    runs++;
    if (runs > 20) throw new Error('runaway edge');
  });

  await machineBusy(async () => { schedule(); });
  const afterFirst = runs;
  await new Promise(r => setTimeout(r, 50));

  assert.equal(afterFirst, 1, 'one staging, one run');
  assert.equal(runs, 1, 'and it stayed at one — no self-sustaining edge');
});
