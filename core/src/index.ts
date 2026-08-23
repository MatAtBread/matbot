export type * from './types.js';
// matbot's typed errors are duck-typed: factory `xError()` builders + `isXError()` brand guards are
// runtime values (re-exported here, since the `export type *` above would strip their value meaning),
// while the `XError` shapes are types (re-exported below). StoreQueryError is still a class value.
// Every branded error, uniformly: a partial list meant a consumer importing from core got some guards and
// silently missed others (readOnlyError/isReadOnlyError were absent, though the pump depends on the guard).
export {
  missingSecretError, isMissingSecretError,
  incompatibleRuntimeError, isIncompatibleRuntimeError,
  notAPluginError, isNotAPluginError,
  promptCancelledError, isPromptCancelledError,
  readOnlyError, isReadOnlyError,
  mediaRejectedError, isMediaRejectedError,
  StoreQueryError,
} from '@matatbread/matbot-plugin-api';
export type {
  MissingSecretError, IncompatibleRuntimeError, NotAPluginError, PromptCancelledError, ReadOnlyError,
  MediaRejectedError, MatbotErrorKind,
} from '@matatbread/matbot-plugin-api';
export { applyCreateSecret }  from '@matatbread/matbot-plugin-api';
export { isTruncatedToolResult, notifyingStore, ItemChangeKind, RegistryChangeKind } from '@matatbread/matbot-plugin-api';
// Ambient security principal: the interface is a type (carried by `export type *`); these are the values.
export { currentPrincipal, tryCurrentPrincipal, runAs, lastActivityAt } from '@matatbread/matbot-plugin-api';
// Host boot assembly, from plugin-api's `/host` subpath. An embedding app gets these through core and
// needs no direct dependency on plugin-api; a *plugin* has no business with any of them, which is why
// they are not on the plugin-api root. Re-exported here (not `export type *`ed) so their value meaning
// survives.
export {
  unifyServices, forwardingProxy, makeSwappable, singleTurnRequest, createMountTable,
  createBroadcaster, subscribable, createNotifier, scopedNotifier,
  installPrincipalCarrier, enterPrincipal, createConstantPrincipalCarrier,
  contextSwitch, machineBusy, quiesced, onContextQuiesce, scheduleAtEdge,
  installUsageCarrier, createSerialUsageCarrier, recordUsage, recordSpan, currentUsageSink,
  currentUsageScope, currentUsageSite, withUsageScope, withUsageSite,
} from '@matatbread/matbot-plugin-api/host';
export type {
  Subscribable, Broadcaster, Routed, RoutedFilter, SwapFn, MountTable, PrincipalCarrier, UsageCarrier,
  UsageScope, Quiescer,
} from '@matatbread/matbot-plugin-api/host';
export * from './session.js';
export * from './usage.js';
export * from './hooks.js';
export * from './runner.js';
export * from './session-runner.js';
export * from './plugin.js';
export * from './registry.js';
export * from './settings.js';
export * from './loader.js';
export * from './tool-registry.js';
export * from './provider-registry.js';
export * from './system-context.js';
export * from './single-turn.js';
export * from './media.js';
export * from './about.js';
export * from './config/index.js';
export * from './security/index.js';
export * from './knowledge/index.js';
