// A minimal multi-subscriber fan-out for AsyncIterable observation streams (registry watch,
// plugin watch). Each subscriber gets its own unbounded queue, so a slow consumer never blocks
// emit() or its peers. Acceptable because the events are rare and small (tool/plugin CRUD);
// this is not a high-throughput data path. emit() is synchronous and never throws.

interface Subscriber<T> {
  queue: T[];
  wake:  (() => void) | undefined;
  done:  boolean;
}

export interface Broadcaster<T> {
  emit(value: T): void;
  subscribe(signal?: AbortSignal): AsyncIterable<T>;
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

  return { emit, subscribe };
}
