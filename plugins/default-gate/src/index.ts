/*
 * matbot's default permission policy, and the tool that inspects it.
 *
 * A LIBRARY, not a plugin — the same shape as `@matatbread/matbot-tool-plugin`, and for the same
 * reason. The behaviour a `PermissionGate` governs has to exist on every install, including a
 * minimal one with an empty `plugins:` list: the first thing a fresh install does is add a plugin or
 * a provider, which is a gated operation. A host therefore seeds this policy as its boot
 * `PermissionGate` and `gate_action` as a built-in tool, exactly as it seeds `plugin`/`provider` —
 * rather than making the answer depend on whether a config line is present.
 *
 * Being host-seeded is also what keeps `gate_action` from colliding with itself: a plugin registering
 * the same tool name over the builtin would raise the very `tools.overwrite` gate this package
 * implements, at boot, on every start.
 *
 * Replacing the policy is unaffected and is still the point of the seam: a plugin registers its own
 * `PermissionGate` (capturing the one it displaces), and unregistering reverts to the host's.
 */

import type { PluginSettings, Tool } from '@matatbread/matbot-plugin-api';
import { makeGateActionTool } from './tool.js';

export { createDefaultGate, toStandingAnswer, WRITTEN_GATES_KEY, DEFAULT_GATE_SETTINGS_NS } from './gate.js';
export type { StandingAnswer } from './gate.js';
export { makeGateActionTool } from './tool.js';
export type { GateAnswer } from './tool.js';

/** The tools a host seeds alongside the default gate. One today; a list because that is what a host's
 *  builtin seeding takes, and what `createBuiltinTools` next door already is. */
export function createGateTools(settings: PluginSettings): Tool[] {
  return [makeGateActionTool(settings)];
}
