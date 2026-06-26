---
"@matatbread/matbot-cli": minor
---

Harden the host-shared singletons (plugin-api/core) against duplication in skewed installs, so a
second physical copy is benign instead of corrupting. Two changes, per an audit of all module-level
state (see new `docs/duplicate-singletons.md`):

- **State-shaped singletons now live on `globalThis`.** New `globalSlot()` helper anchors shared
  state under one `Symbol.for` key; the context-switch quiescers/depth/flushing state (reachable by a
  storage plugin) moves there, joining the principal carrier. Duplicate copies share one object
  rather than splitting.

- **Typed errors are now duck-typed, not classes** (BREAKING for code using them). `MissingSecretError`,
  `IncompatibleRuntimeError`, `NotAPluginError`, `PromptCancelledError` are now plain `Error`s carrying
  a `matbot` brand string. Construct with the `xError()` factory and detect with the `isXError()` guard
  instead of `new XError()` / `instanceof XError` — the brand is identity-independent, so a guard works
  across module copies (where `instanceof` silently returned `false`). The `XError` names remain as
  **types** for annotations and field access. `StoreQueryError` is unchanged (not reached by
  `instanceof` across the boundary).
