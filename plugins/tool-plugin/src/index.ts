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
export { classifySpecifier, canonicalLocalSpecifier, fetchRemoteManifest, materializeRemote, remoteDependencyNotes,
         hostOwnPackageDir } from './remote-cache.js';
// A refresh sets the previous cached copy aside rather than deleting it, so a reload whose load fails can
// put the working one back. The `plugin` tool drives the pair; the tests drive them directly.
export { restoreRemote, discardRestore } from './remote-cache.js';
// What `remove` takes back: a fetched plugin's cache by derivation, the project's files by the record `add`
// writes as it changes them. Exported for `matbot install`, which installs too, and for the tests.
export { releaseRemote } from './remote-cache.js';
export { readInstallRecord, writeInstallRecord, dropInstallRecord, declaredDependencies, isPackageName }
  from './install-record.js';
export type { InstallRecord } from './install-record.js';
export type { Classified, RemoteManifest, MaterializedRemote } from './remote-cache.js';
// Provisioning a local plugin's dependencies: the `plugin` tool drives it, and its tests drive it directly
// — the plan/apply split exists so a caller can fold the resolved set into an approval it already asks for.
export { planProvision, applyProvision, discardProvision, localProvision, isRegistryRange } from './provision.js';
export type { ProvisionPlan } from './provision.js';
// A second copy of a host singleton: reported by `plugin list`, and once at boot by a host that has
// somewhere to print it.
export { findDuplicateSingletons, describeDuplicateSingleton } from './singletons.js';

import { pluginTool } from './tools/plugin.js';

export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
