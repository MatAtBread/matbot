/*
 * `@matatbread/matbot-plugin-api` — everything a plugin author needs, and nothing a host needs to *build*
 * a machine. Boot wiring (carrier installers, swap proxies, the mount table's producer half, the hook
 * registry impl, the broadcaster) lives behind the `/host` subpath; see host.ts for the reasoning.
 *
 * Star-exported where a file is wholly plugin-facing; enumerated where a file is deliberately split. The
 * two enumerated cases use `export type *` for the shapes plus a named list of runtime values, so a new
 * *type* flows out automatically and a new *value* is a decision someone has to make here.
 */

export type * from './types.js';
export { CONFIRM_YES, CONFIRM_NO, isTruncatedToolResult } from './types.js';

export * from './base64.js';
export * from './bytes.js';
export * from './store-query.js';
export * from './errors.js';
export * from './vault.js';
export * from './session.js';
export * from './invoke-tool.js';

// The plugin half of the machine: MatbotPlugin/MatbotServices/MatbotRuntime, the mount-table *consumer*
// contract, and the API version a plugin declares. Host assembly is in ./host-machine.ts.
export type * from './plugin.js';
export { PLUGIN_API_VERSION } from './plugin.js';

// Ambient principal: read it, or establish one for an inbound request/message. Installing the carrier is
// the host's job (`/host`).
export { currentPrincipal, tryCurrentPrincipal, runAs } from './principal-context.js';

// Notifications: publish, consume, and the two kinds plugin-api itself defines. Minting the process
// notifier is the host's job (`/host`).
export type * from './notify.js';
export { ItemChangeKind, RegistryChangeKind, notifyingStore } from './notify.js';

// The quiescent edge: defer work to the next moment it is safe to touch machine state. A plugin that has
// something to do after the current operation — a store edit the running turn would otherwise write over —
// wants exactly this and nothing else in the file. HOLDING the machine (`machineBusy`, `contextSwitch`),
// waiting on it (`quiesced`) and coalescing repeated stagings (`scheduleAtEdge`) are the host's side, so
// they stay behind `/host`.
export type * from './context-switch.js';
export { onContextQuiesce } from './context-switch.js';
