import type { Principal, Store } from './types.js';
import { createBroadcaster } from './broadcast.js';
import { tryCurrentPrincipal } from './principal-context.js';

/**
 * What every notification carries, whoever produced it and however it arrived.
 *
 * Two independent axes ride here, and conflating them is the mistake this shape exists to prevent:
 *
 *   - **attribution** — `instance`/`plugin`/`source`: who *produced* the fact. Drives per-producer
 *     filtering, and lets a bridge suppress its own echo.
 *   - **ownership** — `principal`: whose *data* the fact is about. This is the visibility axis, the
 *     input to `WatchVisibility.visible`. A notification with no principal is a global fact.
 *
 * A producer never sets `instance`: undefined means "this matbot". A bridge stamps it on ingress, so a
 * forwarded event stays attributable to the server that produced it and never loops back out.
 */
export interface NotificationBase {
  /** The shape tag. Selects the arm of {@link Notifications} — narrow on this to read the payload. */
  readonly kind:       string;
  /** Producing plugin's name; `core` is reserved for the host and core itself. Defaulted from the
   *  emitting plugin's scope, so an ordinary producer never sets it. It stays overridable rather than
   *  enforced because relaying another producer's event is a legitimate act — that is exactly what a
   *  bridge does with a notification it received from another instance. */
  readonly plugin:     string;
  /** Producer-defined sub-channel within that plugin (`tools`, `save`, `job-output`, …). Opaque to core. */
  readonly source:     string;
  /** Originating matbot instance. Undefined ⇒ produced locally. Set only by a bridge, on ingress. */
  readonly instance?:  string;
  /** Whose data this is about — the visibility axis, NOT attribution. Undefined ⇒ a global fact. */
  readonly principal?: Principal;
}

/**
 * A stored item changed. Carries identity, never the value: an event is queued per subscriber and is
 * stale the moment a concurrent writer lands, so a consumer that acts on a payload races the store it
 * is mirroring. Read through the store by `id` to get truth; treat this as invalidation.
 *
 * `namespace` is the ROUTING namespace (`files`, `skills`, `sessions`, a document namespace) — the axis
 * a profile isolates and `visible` routes on — not a content sub-namespace. `detail` is advisory only:
 * a cheap payload for an in-place UI update (a file's size) that a consumer may render but must never
 * treat as authoritative.
 */
export interface StoreChangeNotification extends NotificationBase {
  readonly kind:      'store-change';
  readonly namespace: string;
  readonly id:        string;
  readonly operation: 'saved' | 'deleted';
  readonly detail?:   unknown;
}

/** A process-global registry gained or lost a member (tools, plugins). No owner, no item identity. */
export interface RegistryNotification extends NotificationBase {
  readonly kind:      'registry';
  readonly registry:  string;
  readonly name:      string;
  readonly operation: 'added' | 'removed';
}

/**
 * The registry of notification shapes, keyed by `kind` — augment it exactly like `MatbotServices` /
 * `MarkerData` / `ToolContracts` to add your own:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface Notifications { 'job-progress': JobProgressNotification }
 *   }
 *
 * **The set is open at runtime.** A kind can arrive from a plugin that isn't in this build, or bridged
 * from another server — so a `switch (n.kind)` over notifications must always have a `default`, and
 * exhaustiveness checking is unsound here (unlike a closed discriminated union). A bridge that wants a
 * foreign kind typed augments this itself; otherwise it validates at its own boundary, like any other
 * system edge.
 */
export interface Notifications {
  'store-change': StoreChangeNotification;
  'registry':     RegistryNotification;
}

export type Notification = Notifications[keyof Notifications];

/** What a producer passes to {@link Notifier.notify}: any registered arm, minus the `plugin` the runtime
 *  stamps. Mapped over the registry (not `Omit<Notification, …>`) so it distributes across arms and picks
 *  up augmentations. `plugin` stays settable for the one caller that legitimately relays another's event —
 *  a bridge replaying a remote notification. */
export type NotifyInput = {
  [K in keyof Notifications]: Omit<Notifications[K], 'plugin'> & { plugin?: string };
}[keyof Notifications];

/** Per-subscriber predicate. Applied at emit time, so a subscriber never queues what it didn't ask for. */
export type NotificationFilter = (notification: Notification) => boolean;

/**
 * The notification bus: one fan-out for every "something changed" fact a frontend, cache, or bridge
 * needs, replacing the per-kind bespoke streams each producer used to hand out.
 *
 * A swappable {@link MatbotServices} member, not fixed runtime plumbing. The host boots an in-process
 * broadcaster; `register('Notifier', …)` swaps in a distributed one (Redis, NATS, a matbot-to-matbot
 * bridge) behind the usual capture-safe proxy, and unloading that plugin reverts to the host's default.
 * Matbot owns the envelope and the registration surface; it does not own delivery.
 *
 * **What matbot guarantees, and an alternative implementation must preserve:**
 *   - `notify` never throws and never blocks — enqueue and return; a slow subscriber blocks nobody.
 *   - Ordered per producer to each subscriber. No ordering across producers.
 *   - Local delivery is at-most-once, in-memory. **No persistence, no replay, no delivery guarantee.**
 *     A sink attaching mid-flight has missed whatever preceded it — so a sink re-queries on attach and
 *     treats notifications purely as invalidation. Never put current state in the bus.
 *   - Filters are applied before queueing.
 *   - An implementation that forwards off-box MUST stamp `instance` on ingress and MUST NOT forward a
 *     notification that already carries a foreign `instance` — that is the loop break.
 */
export interface Notifier {
  /** Publish. `plugin` is stamped from the calling plugin's scope unless explicitly relayed. */
  notify(notification: NotifyInput): void;
  subscribe(signal?: AbortSignal, filter?: NotificationFilter): AsyncIterable<Notification>;
  /** Detached observation loop: awaits each handler before pulling the next, isolates a throwing
   *  handler, ends when `signal` aborts. The fire-and-forget form of the for-await every sink writes. */
  consume(handler: (notification: Notification) => void | Promise<void>, signal?: AbortSignal, filter?: NotificationFilter): void;
}

/**
 * The host's boot default: in-process fan-out over the shared broadcaster, one queue per subscriber.
 * `defaultPlugin` is stamped on anything published without one — the host passes `core`, and the
 * per-plugin scope built in setupPlugin passes the plugin's own name.
 */
export function createNotifier(defaultPlugin: string): Notifier {
  const events = createBroadcaster<Notification>();
  return {
    notify(notification) {
      events.emit({ ...notification, plugin: notification.plugin ?? defaultPlugin } as Notification);
    },
    async *subscribe(signal?: AbortSignal, filter?: NotificationFilter) {
      for await (const event of events.subscribe(signal, filter ? e => filter(e.value) : undefined)) yield event.value;
    },
    consume(handler, signal?, filter?) {
      events.consume(e => handler(e.value), signal, filter ? e => filter(e.value) : undefined);
    },
  };
}

/** Re-scope a notifier so everything published through it is attributed to `plugin`. */
export function scopedNotifier(notifier: Notifier, plugin: string): Notifier {
  return {
    notify(notification) { notifier.notify({ ...notification, plugin: notification.plugin ?? plugin } as NotifyInput); },
    subscribe: (signal, filter) => notifier.subscribe(signal, filter),
    consume:   (handler, signal, filter) => notifier.consume(handler, signal, filter),
  };
}

/**
 * Wrap a store so every successful write announces itself. For a namespace with ONE writer, an explicit
 * `notify` at that writer is clearer; use this where a namespace has many — `sessions` is written by the
 * turn pump (title derivation, persist-at-turn-start, the assistant commit), the `session_action` tool
 * (rename/hide/unhide), `session_edit` (fork/split), and the frontend (a session minted over HTTP). One
 * wrapper covers them all and cannot be forgotten by the next writer to arrive.
 *
 * It sits ABOVE the backend, so it is storage-independent (no backend implements anything) and profile-
 * independent (the principal is read ambiently at write time, which is also what makes it the correct
 * partition for visibility filtering). It observes writes made THROUGH it — a second process, or a
 * writer that bypassed this store, is not seen; that is what a backend's own watch, where one exists,
 * is for.
 */
export function notifyingStore<T extends { id: string; version: string }>(
  store: Store<T>, notifier: Notifier, namespace: string, source: string,
): Store<T> {
  const announce = (operation: 'saved' | 'deleted', id: string): void => {
    const principal = tryCurrentPrincipal();
    notifier.notify({
      kind: 'store-change', source, operation, namespace, id,
      ...(principal !== undefined ? { principal } : {}),
    });
  };
  return {
    get:   id => store.get(id),
    query: q  => store.query(q),
    async set(id, value)          { await store.set(id, value); announce('saved', id); },
    async cas(id, expected, next) {
      const res = await store.cas(id, expected, next);
      if (res.ok) announce('saved', id);
      return res;
    },
    async delete(id, expectedVersion) {
      const deleted = await store.delete(id, expectedVersion);
      if (deleted) announce('deleted', id);
      return deleted;
    },
  };
}
