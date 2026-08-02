export type * from './types.js';
// matbot's typed errors are duck-typed: factory `xError()` builders + `isXError()` brand guards are
// runtime values (re-exported here, since the `export type *` above would strip their value meaning),
// while the `XError` shapes are types (re-exported below). StoreQueryError is still a class value.
export {
  missingSecretError, isMissingSecretError,
  incompatibleRuntimeError, isIncompatibleRuntimeError,
  notAPluginError, isNotAPluginError,
  promptCancelledError, isPromptCancelledError,
  StoreQueryError,
} from '@matatbread/matbot-plugin-api';
export type {
  MissingSecretError, IncompatibleRuntimeError, NotAPluginError, PromptCancelledError, MatbotErrorKind,
} from '@matatbread/matbot-plugin-api';
export { applyCreateSecret }  from '@matatbread/matbot-plugin-api';
// unifyServices is a runtime fn; the `export type *` above would otherwise strip its value meaning.
export { unifyServices }      from '@matatbread/matbot-plugin-api';
// Same: pure runtime helpers that would otherwise be stripped to type-only by `export type *`.
export { forwardingProxy, makeSwappable, singleTurnRequest, createMountTable } from '@matatbread/matbot-plugin-api';
// Observation-stream primitives (broadcaster + the bare-subscribe wrapper); the host wires `mounted`.
export { createBroadcaster, subscribable } from '@matatbread/matbot-plugin-api';
export { createNotifier, scopedNotifier, notifyingStore, ItemChangeKind, RegistryChangeKind } from '@matatbread/matbot-plugin-api';
export type { Subscribable, Broadcaster } from '@matatbread/matbot-plugin-api';
// Ambient security principal: interface is a type (carried by `export type *`); these are the values.
export {
  installPrincipalCarrier, currentPrincipal, tryCurrentPrincipal,
  runAs, enterPrincipal, createConstantPrincipalCarrier,
  contextSwitch, onContextQuiesce, flushIfQuiescent,
  installUsageCarrier, createSerialUsageCarrier, recordUsage, currentUsageSink, withUsageScope,
  lastActivityAt,
} from '@matatbread/matbot-plugin-api';
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
export * from './about.js';
export * from './config/index.js';
export * from './security/index.js';
export * from './knowledge/index.js';
