# Duplicate singletons & version skew

## The hazard

`@matatbread/matbot-plugin-api` and `@matatbread/matbot-core` are **host-shared singletons**: the
host and every plugin must resolve to *one* physical copy. When they don't — a skewed install where
a plugin bundles its own copy at a version that doesn't dedupe with the host's — two copies load at
once, and anything carried at module scope **splits**: the host writes one copy's state, a plugin
reads the other's, and the two never agree.

This is easy to hit in practice. Caret ranges on `0.x` versions (`^0.1.8` ≡ `>=0.1.8 <0.2.0`) don't
overlap across a minor bump, so upgrading the host while leaving an older plugin pinned strands a
second copy. (See also the npm-side discussion in [DEVELOPING.md](./DEVELOPING.md).) We hit exactly
this with the principal carrier — a host installed it into one copy, a plugin read the other, every
principal lookup threw "No PrincipalCarrier installed".

## The principle: make duplication *benign*, not *forbidden*

Rather than only detecting skew, we eliminate the failure modes so a second copy is harmless. Every
piece of module-level state in the two singletons is one of two shapes:

| Shape | Example | Fix |
|---|---|---|
| **State-shaped** — a Set/Map/counter the copies should share | principal carrier, context-switch quiescers/hold count | Anchor on `globalThis` under a `Symbol.for` key → every copy reads one shared object |
| **Identity-shaped** — relies on object identity across the boundary | `instanceof` of a plugin-api error class | Replace identity with a **brand** (a string field) → identity-independent, works across copies |

Both convert "must be one copy" into "duplication is benign". With them in place, **detection
becomes optional** — useful as a diagnostic for bloat, not required for correctness.

## State-shaped: the global slot

[`plugin-api/src/global-state.ts`](../plugin-api/src/global-state.ts) exposes `globalSlot(name,
init)`, backed by one `Symbol.for('@matatbread/matbot.globalState')` bag on `globalThis`. Any module
that needs cross-copy-shared state stores it there instead of in a module-level `let`/`const`:

```ts
const cs = globalSlot('context-switch', () => ({ quiescers: new Set(), depth: 0, flushing: false }));
cs.depth++;   // every copy mutates the same object
```

`init` must return a **container** — primitives can't be shared by reference, so counters live as
fields inside an object.

**The principal carrier is the exception.** It predates this module and stays on its own established
`Symbol.for('@matatbread/matbot-plugin-api#principalCarrier')` key. Moving it would re-split it in
mixed-version trees (an old published copy looks at the old key, a new copy at the new one) — the
exact bug it fixes — so it is deliberately left where it is.

## Identity-shaped: branded errors

plugin-api's typed errors are **duck-typed, not classes** (see
[`plugin-api/src/errors.ts`](../plugin-api/src/errors.ts)). Each is a plain `Error` carrying a
`matbot` brand string plus its fields; the shape keeps the `XError` name as an **interface**:

```ts
export interface MissingSecretError extends Error { matbot: 'MissingSecret'; readonly missingKeys: readonly string[]; }
export function missingSecretError(missingKeys: readonly string[]): MissingSecretError { /* Object.assign(new Error(…), { matbot:'MissingSecret', … }) */ }
export function isMissingSecretError(e: unknown): e is MissingSecretError { /* e?.matbot === 'MissingSecret' */ }
```

- **Construct** with the factory: `throw missingSecretError(keys)` (not `new MissingSecretError`).
- **Detect** with the guard: `if (isMissingSecretError(e))` (not `e instanceof MissingSecretError`).
- **Annotate / read fields** with the type: `import type { MissingSecretError }`; after the guard,
  `e.missingKeys` is typed.

Because the brand is a string, the guard holds even when the error was thrown by a different physical
copy of plugin-api than the one the guard came from.

## Rules for contributors

- **Never rely on `instanceof` for a plugin-api/core error across the host↔plugin boundary.** Use
  the `isXError` guard. (`instanceof Error` is fine — that class isn't ours.)
- **Don't add module-level mutable state to plugin-api/core that a plugin can reach.** If it's reachable, put it in a `globalSlot`. Host-only state (e.g. core's plugin registry, the loader's freshness counter) is exempt — plugins never import core's main entry, only `services` and the author-facing subpaths — but say so in a comment.
- **New typed error?** Add it to `errors.ts` as interface + `xError()` factory + `isXError()` guard, and a `MatbotErrorKind` member. Don't reach for a class.

## Known latent (not yet converted)

- **`StoreQueryError`** ([`plugin-api/src/store-query.ts`](../plugin-api/src/store-query.ts)) is
  still a class. It is thrown by the storage-base query engine and could be caught by a storage
  backend plugin, but nothing `instanceof`-checks it across the boundary today (it already carries a
  `code` discriminant). Convert it to the branded form if a backend ever needs to catch it by type.
- **core's registry state & freshness counter** are state-shaped but **host-only** — reached only by
  the one host that loads core's main entry, never across a plugin boundary — so they are left as
  module-level state by design.
