import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool }           from './tools/plugin.js';
export { createProviderTool }   from './tools/provider.js';
export { classifySpecifier, canonicalLocalSpecifier, fetchRemoteManifest, materializeRemote, remoteDependencyNotes } from './remote-cache.js';
export type { Classified, RemoteManifest, MaterializedRemote } from './remote-cache.js';
// Provisioning a local plugin's dependencies: the `plugin` tool drives it, and its tests drive it directly
// — the plan/apply split exists so a caller can fold the resolved set into an approval it already asks for.
export { planProvision, applyProvision, discardProvision, isRegistryRange } from './provision.js';
export type { ProvisionPlan } from './provision.js';
// A second copy of a host singleton: reported by `plugin list`, and once at boot by a host that has
// somewhere to print it.
export { findDuplicateSingletons, describeDuplicateSingleton } from './singletons.js';

import { pluginTool } from './tools/plugin.js';

export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
