import type { Principal } from './types.js';

/**
 * Ambient carrier for the security {@link Principal} — the single mechanism by which any layer
 * (runner, hook, tool, or a Store/FileStore/Vault/KnowledgeIndex backend) discovers *who*
 * originated the current operation, without that identity being threaded through every signature.
 *
 * The host installs one platform implementation at boot via {@link installPrincipalCarrier}:
 *   - node (multi-user, concurrent turns): an `AsyncLocalStorage`-backed carrier — each turn /
 *     request runs in its own isolated scope (see the node app's `createAlsPrincipalCarrier`).
 *   - browser / any single-principal realm: {@link createConstantPrincipalCarrier} — there is only
 *     ever one principal, so no async isolation is needed and `run` is a passthrough.
 *
 * Carrying the principal *grants nothing*. A backend MAY call {@link currentPrincipal} (or
 * {@link tryCurrentPrincipal}) to attribute, branch on, or reject an operation; the default
 * implementations ignore it entirely. Policy is the service's concern — this is only the wire.
 */
export interface PrincipalCarrier {
  /** The principal in force for the current async flow. Throws if none is established. */
  current(): Principal;
  /** The principal in force, or `undefined` when called outside any established scope. */
  tryCurrent(): Principal | undefined;
  /**
   * Establish `principal` for the dynamic extent of `fn` and return whatever `fn` returns. On node
   * this is per-async-flow (concurrent turns stay isolated); nesting cleanly shadows-and-restores,
   * which is how in-flow delegation works. An implementation establishes the scope and nothing more:
   * deferred work returned out of it (an unpulled iterator, a promise of one) is {@link runAs}'s to
   * re-establish, and doing it here as well would only nest the same identity twice.
   */
  run<T>(principal: Principal, fn: () => T): T;
  /**
   * Imperatively establish `principal` for the remainder of the current flow — for a process or
   * request *entry* that has no wrapping `fn` (a spawned worker reading its delegated identity, a
   * boot default). Throws if a principal is already established here: re-entry is a wiring bug, and
   * legitimate delegation belongs in a nested {@link run} or at a fresh process boundary.
   */
  enter(principal: Principal): void;
}

// The carrier is process-global, not module-local: a published install can end up with two physical
// copies of this package (npm nesting under a version skew, a mixed .plugins/npm tree, pnpm peer
// suffixes). A plain module `let` would then give each copy its own carrier — the host installs into
// one, a plugin reads the other, and every principal read throws. Anchoring it on `globalThis` under a
// well-known symbol lets all copies share the single carrier the host installs at boot. Deduping the
// package (caret ranges) is still preferred; this just makes duplication harmless rather than fatal.
const CARRIER_KEY = Symbol.for('@matatbread/matbot-plugin-api#principalCarrier');
type CarrierGlobal = { [CARRIER_KEY]?: PrincipalCarrier };

/** Install the host's platform carrier. Called once at boot, before any turn or request runs. */
export function installPrincipalCarrier(impl: PrincipalCarrier): void {
  (globalThis as CarrierGlobal)[CARRIER_KEY] = impl;
}

function need(): PrincipalCarrier {
  const carrier = (globalThis as CarrierGlobal)[CARRIER_KEY];
  if (carrier === undefined) {
    throw new Error('No PrincipalCarrier installed — the host must call installPrincipalCarrier() at boot.');
  }
  return carrier;
}

/** The principal in force for the current flow. Throws if called with no carrier or no scope. */
export function currentPrincipal(): Principal {
  return need().current();
}

/** The principal in force, or `undefined` when no carrier is installed or no scope is established.
 *  Backends that want to fail-open on out-of-scope access read this instead of {@link currentPrincipal}. */
export function tryCurrentPrincipal(): Principal | undefined {
  return (globalThis as CarrierGlobal)[CARRIER_KEY]?.tryCurrent();
}

/** Run `fn` with `principal` established as the ambient identity for its async extent. */
export function runAs<T>(principal: Principal, fn: () => T): T {
  const carrier = need();
  return carrier.run(principal, () => rescope(carrier, principal, fn()));
}

// A generator's body does not begin until the first pull, so an iterator returned out of the scope carries
// its whole extent with it: `fn` established the identity for the *construction*, and the work then runs in
// whatever flow happens to pull it. The tool ABI returns exactly that shape (`executor.execute()`), so the
// natural thing to write at a tool seam was the broken thing — silently, since a host that entered a boot
// principal reads a plausible one rather than throwing. Re-establishing per pull rather than requiring the
// caller to consume inside `fn`: the principal is a re-entrant label that grants nothing, and nesting
// already shadows-and-restores, so re-entering costs nothing semantically — which is also what makes nesting
// unremarkable: `runAs(A, () => runAs(B, () => gen()))` stacks two wrappers and every pull resolves to B,
// the same answer plain nesting gives with no iterator in sight. Deliberately NOT extended to
// `machineBusy` or `withUsageScope`, whose shape is identical but whose hold and roll-up settle when `fn`
// does — a resource with a settle edge cannot be re-entered per pull, only an identity can.
function rescope<T>(carrier: PrincipalCarrier, principal: Principal, value: T): T {
  if (isAsyncIterator(value)) return scopedIterator(carrier, principal, value) as T;
  // `async () => execute(...)` defers the identical body behind one await. This DERIVES a promise rather
  // than intercepting one, which is why a single `then` covers it: `catch`/`finally` on what the caller
  // receives are downstream of the rescope, and a rejection is a value rather than a deferred body, so an
  // `onRejected` would have nothing to re-establish and would cost the rejection's identity. Native only —
  // `PromiseLike.then` need not return a promise, so adopting a thenable would replace an object the caller
  // may use for more than awaiting (a chainable query builder), and `async` produces the native one anyway.
  if (value instanceof Promise) return value.then(inner => rescope(carrier, principal, inner)) as T;
  return value;
}

// Iterator-shaped, not merely async-iterable. A ReadableStream is `for await`-able too, and CAN be proxied
// (measured: `instanceof`, `pipeTo` and a platform `new Response(stream)` all survive one) — but only two of
// its pull paths could then be re-entered, `[Symbol.asyncIterator]` and `getReader().read()`, while
// `pipeTo`/`pipeThrough`/`tee` pull from platform internals no wrapper reaches. A conditional guarantee is
// worse than none in an identity primitive: a host testing with `for await` and shipping `pipeTo` would
// regress silently. Its eager half is safe either way — `start()` runs at construction, inside the scope —
// so what is uncovered is a lazy `pull()` that reads the principal, which no in-repo streamer is: every one
// is an async generator, and `FileHandle.stream()` is `AsyncIterable` by contract. Carrying `next` is then
// taken to mean the value IS the iterator — what a caller holding `execute()`'s result has — rather than a
// factory for fresh ones, a thing it cannot also be.
function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> & AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null
    && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
    && typeof (value as AsyncIterator<unknown>).next === 'function';
}

function scopedIterator<T>(
  carrier:   PrincipalCarrier,
  principal: Principal,
  source:    AsyncIterator<T> & AsyncIterable<T>,
): AsyncIterableIterator<T> {
  const inScope = <R>(f: () => R): R => carrier.run(principal, f);
  // A Proxy rather than a fresh object literal: the value crossing back out must still BE what it was —
  // a custom iterator's own methods, its prototype, `instanceof` — so only the pull points are replaced.
  // Anything else is forwarded bound to the target, which a class-based iterator holding internal state
  // (or an object with internal slots) requires.
  const pulls: Record<PropertyKey, unknown> = {
    [Symbol.asyncIterator]: () => proxy,
    next:   (...args: [] | [undefined]) => inScope(() => source.next(...args)),
    ...(source.return !== undefined ? { return: (value?: unknown) => inScope(() => source.return!(value)) } : {}),
    ...(source.throw  !== undefined ? { throw:  (error?: unknown) => inScope(() => source.throw!(error))  } : {}),
  };
  const proxy = new Proxy(source, {
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

/** Imperatively establish `principal` for the current flow (entry points only). */
export function enterPrincipal(principal: Principal): void {
  need().enter(principal);
}

/**
 * A carrier for single-principal realms (the browser, tests): every read returns the same
 * `principal` and `run` is a passthrough, since there is no second identity to isolate from.
 */
export function createConstantPrincipalCarrier(principal: Principal): PrincipalCarrier {
  return {
    current:    () => principal,
    tryCurrent: () => principal,
    run:        (_principal, fn) => fn(),
    enter:      () => {},
  };
}
