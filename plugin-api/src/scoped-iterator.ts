/**
 * Re-enter an ambient scope on every pull of an async iterator.
 *
 * The problem is the same wherever it appears: an async generator's body does not begin until the first
 * pull, so an iterator returned out of a scope carries its whole extent OUT of it — the scope covered
 * the construction, and the work then runs in whatever flow happens to pull it. The tool ABI
 * (`executor.execute()`) returns exactly that shape, so both of matbot's ambient carriers need this, and
 * both had written it out: `runAs` for the principal, and the runner for the usage call site.
 *
 * The two copies did not agree. This one is the careful version: a **Proxy**, so the value crossing back
 * out still IS what it was — a class-based iterator keeps its own members, its prototype and
 * `instanceof` — with only the pull points replaced. The object-literal copy silently dropped all of
 * that, which held only for as long as every tool was a plain async generator.
 *
 * Whether re-entering per pull is *sound* is the caller's question, not this helper's, and the answer
 * differs: an identity is a re-entrant label, so `runAs` re-establishes it freely, while a hold or a
 * roll-up settles when its `fn` does and must not be re-acquired per pull. See `machineBusy` and
 * `withUsageScope`, which deliberately do not use this.
 */

/** Run `f` inside the caller's ambient scope. The shape both `carrier.run(p, f)` and `withUsageSite(s, f)` take. */
export type ScopeFn = <R>(f: () => R) => R;

export function scopeIterator<T>(source: AsyncIterator<T>, inScope: ScopeFn): AsyncIterableIterator<T> {
  const pulls: Record<PropertyKey, unknown> = {
    [Symbol.asyncIterator]: () => proxy,
    next:   (...args: [] | [undefined]) => inScope(() => source.next(...args)),
    ...(source.return !== undefined ? { return: (value?: unknown) => inScope(() => source.return!(value)) } : {}),
    ...(source.throw  !== undefined ? { throw:  (error?: unknown) => inScope(() => source.throw!(error))  } : {}),
  };
  const proxy: AsyncIterableIterator<T> = new Proxy(source, {
    // `hasOwn`, not `in`: the latter reaches Object.prototype, which would serve `toString`/`constructor`
    // off the lookup object instead of the iterator being wrapped.
    get(target, prop) {
      if (Object.hasOwn(pulls, prop)) return pulls[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AsyncIterableIterator<T>;
  return proxy;
}

/**
 * The iterable form: every iterator this hands out is scoped per pull. For a caller holding an
 * `AsyncIterable` that is not itself iterator-shaped — legal, and what a tool returning a bare
 * `{ [Symbol.asyncIterator]() {…} }` gives the runner.
 */
export function scopeIterable<T>(source: AsyncIterable<T>, inScope: ScopeFn): AsyncIterable<T> {
  return { [Symbol.asyncIterator]: () => scopeIterator(source[Symbol.asyncIterator](), inScope) };
}
