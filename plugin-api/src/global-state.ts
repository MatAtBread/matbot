/**
 * Process-global home for matbot's **state-shaped** singletons.
 *
 * A skewed install can load two physical copies of plugin-api (a plugin bundling its own copy at a
 * version that doesn't dedupe with the host's). Module-level state then splits: the host mutates one
 * copy's state, a plugin reads the other's, and the two never agree. Anchoring that state on
 * `globalThis` under one well-known key collapses every copy onto a single shared object, so
 * duplication becomes *benign* rather than corrupting.
 *
 * This handles state — Sets, Maps, counters-in-a-container. It deliberately does NOT cover
 * identity-shaped things (class `instanceof`): a class object is per-copy and can't be shared this
 * way, which is why plugin-api's typed errors are brand-based instead (see ./errors.ts). And the
 * principal carrier predates this module and stays on its own established `Symbol.for` key for
 * backward compatibility with already-published copies — moving it would re-split it in mixed
 * version trees, the exact bug it fixes. See docs/duplicate-singletons.md.
 *
 * Keyed by a registered `Symbol.for` so the lookup is identical across every module copy and
 * resistant to accidental string-key clashes on `globalThis`.
 */

const KEY = Symbol.for('@matatbread/matbot.globalState');

type GlobalState = Record<string, unknown>;

function bag(): GlobalState {
  const g = globalThis as { [KEY]?: GlobalState };
  return (g[KEY] ??= {});
}

/**
 * Return the shared slot named `name`, creating it from `init` on first access. Every copy of every
 * module that asks for the same `name` gets the same object back, so the state is singular however
 * many physical copies are loaded. `init` must produce a *container* (object/Map/Set) — primitives
 * can't be shared by reference, so counters live as fields inside a container.
 */
export function globalSlot<T extends object>(name: string, init: () => T): T {
  const b = bag();
  return (b[name] ??= init()) as T;
}
