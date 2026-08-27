import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPrincipalCarrier, runAs, currentPrincipal, tryCurrentPrincipal } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

// `runAs` re-establishes the principal across deferred work returned out of the scope — an unpulled async
// iterator (the tool ABI's shape) or a promise of one. Before that, the identity was established for the
// *construction* only: with a boot principal entered at process entry (the CLI does this), a host wiring its
// own tool invocation read a plausible-but-wrong principal instead of an error. See issue #53.
installPrincipalCarrier(createAlsPrincipalCarrier());
const P = { id: 'alice', type: 'user' as const };
const Q = { id: 'bob', type: 'user' as const };

// The tool ABI shape: an async generator that awaits mid-body, reading the ambient identity in each segment.
async function* toolLike(): AsyncGenerator<string> {
  yield `open:${currentPrincipal().id}`;
  await new Promise(r => setTimeout(r, 1));
  yield `after-await:${currentPrincipal().id}`;
  await new Promise(r => setTimeout(r, 1));
  yield `late:${currentPrincipal().id}`;
}

test('an iterator returned out of the scope keeps it, consumed outside', async () => {
  const events = runAs(P, () => toolLike());
  const seen: string[] = [];
  for await (const e of events) seen.push(e);
  assert.deepEqual(seen, ['open:alice', 'after-await:alice', 'late:alice']);
});

test('consumed under a DIFFERENT ambient principal: the stream keeps its own', async () => {
  const events = runAs(P, () => toolLike());
  const seen: string[] = [];
  await runAs(Q, async () => { for await (const e of events) seen.push(e); });
  assert.deepEqual(seen, ['open:alice', 'after-await:alice', 'late:alice']);
});

test('consumed with NO ambient principal at all', async () => {
  const events = runAs(P, () => toolLike());
  assert.equal(tryCurrentPrincipal(), undefined);
  const seen: string[] = [];
  for await (const e of events) seen.push(e);
  assert.deepEqual(seen, ['open:alice', 'after-await:alice', 'late:alice']);
});

test('a promise of an iterator is unwrapped and rescoped too', async () => {
  const events = await runAs(P, async () => toolLike());
  const seen: string[] = [];
  for await (const e of events) seen.push(e);
  assert.deepEqual(seen, ['open:alice', 'after-await:alice', 'late:alice']);
});

test('early break runs the generator finally under the scope', async () => {
  let closedAs: string | undefined;
  async function* withFinally(): AsyncGenerator<number> {
    try { yield 1; yield 2; } finally { closedAs = currentPrincipal().id; }
  }
  const events = runAs(P, () => withFinally());
  for await (const _ of events) break;
  assert.equal(closedAs, 'alice');
});

test('throw() into the stream lands under the scope', async () => {
  let caughtAs: string | undefined;
  async function* catcher(): AsyncGenerator<number> {
    try { yield 1; } catch { caughtAs = currentPrincipal().id; }
  }
  const it = runAs(P, () => catcher())[Symbol.asyncIterator]();
  await it.next();
  await it.throw?.(new Error('x'));
  assert.equal(caughtAs, 'alice');
});

test('the scope does NOT leak forward past an await of runAs', async () => {
  await runAs(P, async () => 'done');
  assert.equal(tryCurrentPrincipal(), undefined);
});

test('a ReadableStream survives — not replaced by a bare iterator', async () => {
  const stream = runAs(P, () => new ReadableStream<string>({
    start(c) { c.enqueue(currentPrincipal().id); c.close(); },
  }));
  assert.ok(stream instanceof ReadableStream, 'still a ReadableStream');
  assert.equal(typeof stream.getReader, 'function');
  const chunks: string[] = [];
  for await (const c of stream as unknown as AsyncIterable<string>) chunks.push(c);
  assert.deepEqual(chunks, ['alice']);
});

test('plain values and rejections are untouched', async () => {
  assert.equal(runAs(P, () => 42), 42);
  assert.equal(runAs(P, () => undefined), undefined);
  await assert.rejects(runAs(P, async () => { throw new Error('boom'); }), /boom/);
  assert.throws(() => runAs(P, () => { throw new Error('sync'); }), /sync/);
});

test('concurrent streams under different principals stay isolated', async () => {
  const a = runAs(P, () => toolLike());
  const b = runAs(Q, () => toolLike());
  const [ra, rb] = await Promise.all([
    (async () => { const s: string[] = []; for await (const e of a) s.push(e); return s; })(),
    (async () => { const s: string[] = []; for await (const e of b) s.push(e); return s; })(),
  ]);
  assert.deepEqual(ra, ['open:alice', 'after-await:alice', 'late:alice']);
  assert.deepEqual(rb, ['open:bob', 'after-await:bob', 'late:bob']);
});

test('a class-based async iterator keeps its own members, prototype and instanceof', async () => {
  class Job implements AsyncIterator<string>, AsyncIterable<string> {
    private i = 0;
    cancelledBy?: string;
    async next(): Promise<IteratorResult<string>> {
      return this.i++ === 0 ? { done: false, value: currentPrincipal().id } : { done: true, value: undefined };
    }
    cancel(): void { this.cancelledBy = currentPrincipal().id; }
    [Symbol.asyncIterator](): AsyncIterator<string> { return this; }
  }
  const job = runAs(P, () => new Job());
  assert.ok(job instanceof Job, 'instanceof survives');
  const seen: string[] = [];
  for await (const v of job) seen.push(v);
  assert.deepEqual(seen, ['alice']);
  await runAs(Q, async () => { (job as unknown as Job).cancel(); });
  assert.equal((job as unknown as Job).cancelledBy, 'bob', 'a forwarded member runs in the CALLER scope, not the stream scope');
});

test('rejection identity survives the unwrap (no onRejected needed)', async () => {
  const boom = new Error('boom');
  const caught = await runAs(P, async () => { throw boom; }).catch((e: unknown) => e);
  assert.equal(caught, boom, 'same Error instance, not a re-wrap');
});

test("the caller's catch/finally run in the CALLER's context, not the scope", async () => {
  const seen: (string | undefined)[] = [];
  await runAs(P, async () => { throw new Error('x'); })
    .catch(() => { seen.push(tryCurrentPrincipal()?.id); })
    .finally(() => { seen.push(tryCurrentPrincipal()?.id); });
  assert.deepEqual(seen, [undefined, undefined], 'no privilege extension into caller continuations');
});

test('a rejected promise BEHIND the unwrap still reaches a for-await try/catch', async () => {
  async function* failing(): AsyncGenerator<number> { yield 1; throw new Error('mid-stream'); }
  const events = await runAs(P, async () => failing());
  const seen: number[] = [];
  await assert.rejects(async () => { for await (const v of events) seen.push(v); }, /mid-stream/);
  assert.deepEqual(seen, [1]);
});

test('a non-native thenable is left INTACT — not adopted, not replaced', async () => {
  // Deliberate boundary: PromiseLike.then may return anything, so adopting one would hand the caller a
  // different object. It is therefore not rescoped either — the known limitation, pinned here.
  let ranAs: string | undefined;
  const thenable = { then(resolve: (v: number) => void) { ranAs = tryCurrentPrincipal()?.id; resolve(1); } };
  const returned = runAs(P, () => thenable);
  assert.equal(returned, thenable, 'same object, untouched');
  assert.equal(await returned, 1, 'and its value is not destroyed');
  assert.equal(ranAs, undefined, 'known limitation: an exotic thenable settles in the caller flow');
});

test('an iterator behind an exotic thenable keeps the CONSUMER scope (documented limitation)', async () => {
  async function* tool(): AsyncGenerator<string> { yield currentPrincipal().id; }
  const thenable = { then(resolve: (v: AsyncGenerator<string>) => void) { resolve(tool()); } };
  const events = await runAs(P, () => thenable);
  const seen: string[] = [];
  await runAs({ id: 'bob', type: 'user' }, async () => { for await (const e of events) seen.push(e); });
  assert.deepEqual(seen, ['bob'], 'not rescoped — the object was left intact rather than adopted');
});

test('an override of an Object.prototype member is the target\'s, and a private field survives', async () => {
  class Job implements AsyncIterator<string>, AsyncIterable<string> {
    #pulled = 0;                                     // a private field needs the real receiver
    async next(): Promise<IteratorResult<string>> {
      return this.#pulled++ === 0 ? { done: false, value: currentPrincipal().id } : { done: true, value: undefined };
    }
    toString(): string { return `Job(${this.#pulled})`; }   // shadows Object.prototype.toString
    [Symbol.asyncIterator](): AsyncIterator<string> { return this; }
  }
  const job = runAs(P, () => new Job());
  assert.equal(job.toString(), 'Job(0)', "the target's override, called on the target");
  const seen: string[] = [];
  for await (const v of job) seen.push(v);
  assert.deepEqual(seen, ['alice']);
  assert.equal(job.toString(), 'Job(2)', 'and it still reads the private field after the pulls');
});
