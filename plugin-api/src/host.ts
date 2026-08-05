/*
 * `@matatbread/matbot-plugin-api/host` — the boot-time wiring an *embedder* performs to stand a machine
 * up, as opposed to what a *plugin* is written against.
 *
 * The package root used to export both, which made carrier installers, swap proxies, the mount table and
 * the hook registry implementation look like stable author-facing API. They are not: no plugin in this
 * repo imports one, and only `apps/*` and `core` ever did. Splitting them here lets the root answer one
 * question — what does a plugin need in order to be a plugin? — and lets these change without it being a
 * plugin-API break.
 *
 * Three of these subsystems are deliberately *split* rather than moved whole, because each has a genuine
 * author-facing half that stays at the root:
 *   - principal: `runAs` / `currentPrincipal` / `tryCurrentPrincipal` are read and established by plugins
 *     (a frontend scopes each inbound message); only *installing the carrier* is the host's job.
 *   - notifications: every plugin publishes and consumes; only *minting* the process notifier is the host's.
 *   - mount table: `services.mounted` (`Mounted`, `MountConsumeOptions`) is the plugin contract; the
 *     producer half (`MountTable`, `markDirty`/`flush`) is driven by the host's register/quiescent edge.
 *
 * `core` re-exports everything here, so a host that already depends on `@matatbread/matbot-core` needs no
 * direct import of this subpath.
 */

// Machine assembly: member-access unification, capture-safe swap proxies, the mount table's producer
// half, and the one-shot CompletionRequest builder behind MatbotRuntime.singleTurn.
export * from './host-machine.js';

// Ambient scope carriers. The host installs a platform impl once at boot (node: AsyncLocalStorage;
// browser/single-principal: a constant carrier) and never touches them again.
export { installPrincipalCarrier, enterPrincipal, createConstantPrincipalCarrier } from './principal-context.js';
export type { PrincipalCarrier } from './principal-context.js';
export * from './usage-context.js';

// The machine half of a context switch: quiescent-edge flushers and the deferred-swap application point.
export * from './context-switch.js';

// Hook dispatch implementation. Plugins register hooks through `services.hooks`; only the host constructs
// the registry that backs it.
export { HookRegistry } from './hooks.js';

// The multi-subscriber fan-out primitive under `Notifier`. A plugin that wants to publish an event uses
// the Notifier — that is the sanctioned path, and the reason this stays host-side.
export * from './broadcast.js';
export { createNotifier, scopedNotifier } from './notify.js';
