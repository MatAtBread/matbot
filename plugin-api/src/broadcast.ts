// A minimal multi-subscriber fan-out for AsyncIterable observation streams (tool/plugin/skill watch,
// file changes, and any future plugin-owned CRUD stream). Each subscriber gets its own unbounded queue,
// so a slow consumer never blocks emit() or its peers. Acceptable because these events are rare and small
// (registry/document CRUD); this is not a high-throughput data path. emit() is synchronous and never throws.
//
// Every event flows as a {@link Routed} envelope carrying an optional `origin` principal — the partition
// or actor that produced it. This is the one attribution channel shared by every stream (files, skills,
// future partitioned stores); a global stream (tool/plugin registry) simply never sets it. Per-subscriber
// filtering (`subscribe(signal, filter)`) is applied at emit time, so a subscriber that only wants events
// visible to one principal never even queues the rest — the single, common place per-principal visibility
// lives, whatever the terminal (SSE→frontend, an internal consumer, or a cache).

import type { Principal } from './types.js';

/** A broadcast event plus its optional origin. `origin` undefined ⇒ global/base — visible to all. */
export interface Routed<T> {
  readonly value:   T;
  readonly origin?: Principal;
}

/** Per-subscriber predicate: keep only the envelopes it returns true for. */
export type RoutedFilter<T> = (event: Routed<T>) => boolean;

interface Subscriber<T> {
  queue:  Routed<T>[];
  wake:   (() => void) | undefined;
  done:   boolean;
  filter: RoutedFilter<T> | undefined;
}

// The consumer facet — what a stream hands out. `emit` is the producer's, kept off this so a
// surface that only exposes observation (e.g. services.mounted) cannot forge events.
export interface Subscribable<T> {
  subscribe(signal?: AbortSignal, filter?: RoutedFilter<T>): AsyncIterable<Routed<T>>;
  // Detached observation loop: awaits each handler before pulling the next (no overlapping runs),
  // isolates a throwing handler (logged, never propagated — a bad observer must not kill the stream),
  // and ends when the source ends or `signal` aborts. The fire-and-forget form of the for-await loop
  // every watch call site otherwise hand-writes. An internal cache is exactly this: a `consume` that
  // folds each `Routed<T>` into per-origin state.
  consume(handler: (event: Routed<T>) => void | Promise<void>, signal?: AbortSignal, filter?: RoutedFilter<T>): void;
}

export interface Broadcaster<T> extends Subscribable<T> {
  emit(value: T, origin?: Principal): void;
}

/**
 * Wrap a bare subscribe generator into a full {@link Subscribable}, supplying the standard detached
 * `consume` loop. Use for a *derived* stream — e.g. a per-plugin scoped view of a shared broadcaster —
 * that owns its own subscribe generator but wants the same consume ergonomics as a real broadcaster.
 */
export function subscribable<T>(
  subscribe: (signal?: AbortSignal, filter?: RoutedFilter<T>) => AsyncIterable<Routed<T>>,
): Subscribable<T> {
  const consume = (handler: (event: Routed<T>) => void | Promise<void>, signal?: AbortSignal, filter?: RoutedFilter<T>): void => {
    void (async () => {
      for await (const event of subscribe(signal, filter)) {
        try { await handler(event); }
        catch (e) { console.error('[matbot] consume handler threw:', e instanceof Error ? e.message : e); }
      }
    })();
  };
  return { subscribe, consume };
}

export function createBroadcaster<T>(): Broadcaster<T> {
  const subs = new Set<Subscriber<T>>();

  const emit = (value: T, origin?: Principal): void => {
    const event: Routed<T> = origin !== undefined ? { value, origin } : { value };
    for (const sub of subs) {
      if (sub.filter !== undefined && !sub.filter(event)) continue;
      sub.queue.push(event);
      sub.wake?.();
    }
  };

  async function* subscribe(signal?: AbortSignal, filter?: RoutedFilter<T>): AsyncIterable<Routed<T>> {
    const sub: Subscriber<T> = { queue: [], wake: undefined, done: false, filter };
    subs.add(sub);
    const onAbort = () => { sub.done = true; sub.wake?.(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        while (sub.queue.length > 0) yield sub.queue.shift()!;
        if (sub.done || signal?.aborted) return;
        await new Promise<void>(resolve => { sub.wake = resolve; });
        sub.wake = undefined;
      }
    } finally {
      subs.delete(sub);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return { emit, ...subscribable(subscribe) };
}
