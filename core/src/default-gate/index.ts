/*
 * matbot's default permission policy, and the tool that inspects it.
 *
 * In core, and the `gate` `assembleMachine` uses when a host passes none, because the behaviour a
 * `PermissionGate` governs has to exist on every install, including a minimal one with an empty
 * `plugins:` list: the first thing a fresh install does is add a plugin or a provider, which is a gated
 * operation. So it is seeded at boot rather than loaded, and `gate_action` with it as a built-in tool.
 *
 * Being seeded is also what keeps `gate_action` from colliding with itself: a plugin registering the same
 * tool name over the builtin would raise the very `tools.overwrite` gate this policy implements, at boot,
 * on every start.
 *
 * Replacing the policy is unaffected and is still the point of the seam: a host passes its own `gate`, or
 * a plugin registers its own `PermissionGate` (capturing the one it displaces), and unregistering reverts
 * to the host's.
 */

import type { PluginSettings, Tool } from '@matatbread/matbot-plugin-api';
import { makeGateActionTool } from './tool.js';
import { createDefaultGate, DEFAULT_GATE_SETTINGS_NS } from './gate.js';

export { createDefaultGate, denyKey, toStandingAnswer, DEFAULT_GATE_SETTINGS_NS } from './gate.js';
export type { StandingAnswer } from './gate.js';
export { makeGateActionTool } from './tool.js';
export type { GateAnswer, GateEntry } from './tool.js';

/** The tools a host seeds alongside the default gate. One today; a list because that is what a host's
 *  builtin seeding takes, and what `createBuiltinTools` next door already is. */
export function createGateTools(settings: PluginSettings): Tool[] {
  return [makeGateActionTool(settings)];
}

/** The policy in the shape `assembleMachine` takes as `gate`, and its default. */
export const defaultGate = {
  namespace: DEFAULT_GATE_SETTINGS_NS,
  create:    (settings: PluginSettings) => createDefaultGate(settings),
  tools:     createGateTools,
};
