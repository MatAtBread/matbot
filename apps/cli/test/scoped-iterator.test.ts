import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeIterable, scopeIterator } from '@matatbread/matbot-core';

// Both ambient carriers need the same thing — re-enter a scope on every pull, because an async
// generator's body does not begin until the first one — and both had written it out. The principal's
// copy was a Proxy that preserved the value's identity; the runner's was an object literal that
// replaced the iterator wholesale, so a class-based tool iterator lost its own members, its prototype
// and `instanceof`. One helper now, and these are the properties that were only true on one side.

class Counted implements AsyncIterableIterator<number> {
  #left: number;
  readonly label = 'counted';
  constructor(n: number) { this.#left = n; }
  [Symbol.asyncIterator](): AsyncIterableIterator<number> { return this; }
  async next(): Promise<IteratorResult<number>> {
    return this.#left-- > 0 ? { value: this.#left, done: false } : { value: undefined, done: true };
  }
  double(): number { return 2; }
}

test('every pull runs inside the scope, and the scope is re-entered per pull', async () => {
  const depths: number[] = [];
  let depth = 0;
  const inScope = <R,>(f: () => R): R => { depth++; try { return f(); } finally { depth--; } };

  const it = scopeIterable((async function *() { yield 1; yield 2; })(), inScope);
  for await (const _ of it) depths.push(depth);

  assert.deepEqual(depths, [0, 0], 'the scope is left between pulls');
  assert.equal(depth, 0, 'and not leaked after the loop');
});

test('a class-based iterator keeps its members, prototype and instanceof', async () => {
  const wrapped = scopeIterator(new Counted(2), f => f());

  assert.ok(wrapped instanceof Counted, 'still the same kind of thing');
  assert.equal((wrapped as unknown as Counted).label, 'counted', 'own field');
  assert.equal((wrapped as unknown as Counted).double(), 2, 'own method, bound to the target');

  // The private field is reached through a method on the real target, so it must not throw.
  const seen: number[] = [];
  for await (const n of wrapped) seen.push(n);
  assert.deepEqual(seen, [1, 0]);
});

test('an iterable that is not iterator-shaped is scoped per iterator handed out', async () => {
  let entered = 0;
  const bare: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => (async function *() { yield 'a'; })()[Symbol.asyncIterator](),
  };
  const wrapped = scopeIterable(bare, f => { entered++; return f(); });

  assert.deepEqual([...await Array.fromAsync(wrapped)], ['a']);
  assert.ok(entered > 0, 'the wrap applied to the iterator it produced');
});
