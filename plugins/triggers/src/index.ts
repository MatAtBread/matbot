export type { Trigger, TriggerCondition, TriggerCooldown, TriggerInvoke, TriggerKind, TriggerSurface, TriggerSpec, Triggers, TriggerGate, TriggerGateContext, FiredCondition } from './types.js';
export { surfaceOfKind } from './types.js';
export { TriggerManager }                       from './manager.js';
export { dispatchTrigger, renderResult }        from './dispatch.js';
export { createTriggerActionTool, createTriggersConfigTool } from './tools.js';
export { createTriggersPlugin, setupTriggers, plugin, DEFAULT_GRACE_MS } from './plugin.js';
