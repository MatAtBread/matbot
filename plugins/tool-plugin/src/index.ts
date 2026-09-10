import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool }           from './tools/plugin.js';
// Exported to be tested against the error a real unresolved import throws: it reads a MESSAGE, and the
// one it must read is thrown in apps/cli's ts-hooks, which no compiler ties to this regex.
export { missingPackageOf }     from './tools/plugin.js';
export { createProviderTool }   from './tools/provider.js';
// `provider update`'s write half, split from the executor so the block round-trip can be driven directly
// by a test — the executor's own half is a confirmation prompt over `applyProviderPatch` (plugin-api,
// which is where the patch semantics live, shared with the browser host).
export { writeProviderBlock } from './tools/provider.js';
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
