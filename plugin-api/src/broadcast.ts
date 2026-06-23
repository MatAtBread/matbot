// A minimal multi-subscriber fan-out for AsyncIterable observation streams (tool/plugin/skill watch,
// and any future plugin-owned CRUD stream). Each subscriber gets its own unbounded queue, so a slow
// consumer never blocks emit() or its peers. Acceptable because these events are rare and small
// (registry/document CRUD); this is not a high-throughput data path. emit() is synchronous and never throws.

interface Subscriber<T> {
  queue: T[];
  wake:  (() => void) | undefined;
  done:  boolean;
}

// The consumer facet — what a stream hands out. `emit` is the producer's, kept off this so a
// surface that only exposes observation (e.g. services.mounted) cannot forge events.
export interface Subscribable<T> {
  subscribe(signal?: AbortSignal): AsyncIterable<T>;
  // Detached observation loop: awaits each handler before pulling the next (no overlapping runs),
  // isolates a throwing handler (logged, never propagated — a bad observer must not kill the stream),
  // and ends when the source ends or `signal` aborts. The fire-and-forget form of the for-await loop
  // every watch call site otherwise hand-writes.
  consume(handler: (value: T) => void | Promise<void>, signal?: AbortSignal): void;
}

export interface Broadcaster<T> extends Subscribable<T> {
  emit(value: T): void;
}

/**
 * Wrap a bare subscribe generator into a full {@link Subscribable}, supplying the standard detached
 * `consume` loop. Use for a *derived* stream — e.g. a per-plugin scoped view of a shared broadcaster —
 * that owns its own subscribe generator but wants the same consume ergonomics as a real broadcaster.
 */
export function subscribable<T>(subscribe: (signal?: AbortSignal) => AsyncIterable<T>): Subscribable<T> {
  const consume = (handler: (value: T) => void | Promise<void>, signal?: AbortSignal): void => {
    void (async () => {
      for await (const v of subscribe(signal)) {
        try { await handler(v); }
        catch (e) { console.error('[matbot] consume handler threw:', e instanceof Error ? e.message : e); }
      }
    })();
  };
  return { subscribe, consume };
}

export function createBroadcaster<T>(): Broadcaster<T> {
  const subs = new Set<Subscriber<T>>();

  const emit = (value: T): void => {
    for (const sub of subs) {
      sub.queue.push(value);
      sub.wake?.();
    }
  };

  async function* subscribe(signal?: AbortSignal): AsyncIterable<T> {
    const sub: Subscriber<T> = { queue: [], wake: undefined, done: false };
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
