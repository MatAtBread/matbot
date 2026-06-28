import type { Store, Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import { getSpecifierForPlugin } from '@matatbread/matbot-core';
import { createBrowserPluginTool } from '@matatbread/matbot-browser';

const DOC_ID = 'manifest';

interface ManifestDoc {
  id:         string;
  version:    string;
  specifiers: string[];
}

/**
 * The Drive-synced plugin set, persisted as one doc in the active StorageBackend's `plugin-manifest`
 * namespace (Drive, once this plugin is active). This is *separate* from the browser plugin's local
 * `extra-plugins` list: the local loader is unchanged and keeps managing whatever was installed
 * locally (including this plugin itself), while this set holds what's added once Drive is connected
 * and is restored when the Drive plugin loads. Symmetric ownership — each loader restores its own set.
 *
 * Its shape satisfies the browser plugin tool's `ExtraPlugins` persistence interface, so the very
 * same `plugin` tool can be backed by Drive instead of IndexedDB (see {@link createSyncedPluginTool}).
 */
export class DrivePluginSet {
  private readonly store: Store<ManifestDoc>;

  constructor(store: Store<ManifestDoc>) {
    this.store = store;
  }

  async list(): Promise<string[]> {
    return (await this.store.get(DOC_ID))?.specifiers ?? [];
  }

  async add(specifier: string): Promise<void> {
    const cur = await this.list();
    if (cur.includes(specifier)) return;
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), specifiers: [...cur, specifier] });
  }

  async remove(specifier: string): Promise<void> {
    const cur = await this.list();
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), specifiers: cur.filter(s => s !== specifier) });
  }
}

/**
 * The `plugin` tool, **shadowing** the browser build's built-in one (same name, so the model and the
 * frontend `/tools` path can't tell the difference — there is exactly one `plugin` tool, no ambiguous
 * second). It reuses the browser plugin tool factory verbatim but backs persistence with the
 * Drive-synced set, so `add` now syncs the install across machines.
 *
 * Routing is by *which set a plugin belongs to*, derived from the live Drive set (no stored
 * provenance needed while there are just two managers):
 *  - `add` → always the Drive set (that's the sync behaviour).
 *  - `remove`/`reload` → if the target is Drive-synced, act on Drive; **otherwise delegate to the
 *    original (local) tool**. That covers plugins installed locally before Drive was connected *and*
 *    this Google Drive plugin itself (it lives in the local extras, not the Drive set — a Drive
 *    remove couldn't uninstall it, it'd just reload next boot). Delegation, not a silent no-op.
 *  - `list` → annotates each loaded plugin with whether it's Drive-synced or local-only.
 */
export function createSyncedPluginTool(driveSet: DrivePluginSet, original: Tool | null): Tool {
  const driveTool = createBrowserPluginTool(driveSet);
  return {
    ...driveTool,
    description:
      driveTool.description +
      '\n\nIn this install, `add` saves the plugin to your Google Drive, so it appears on every ' +
      'browser where Drive is connected. `remove`/`reload` of a plugin that is NOT Drive-synced ' +
      '(including the Google Drive plugin itself) is handled locally, on this browser only. `list` ' +
      'marks each plugin as Drive-synced or local-only.',
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const { action, specifier } = input as { action?: string; specifier?: string };

        if ((action === 'remove' || action === 'reload') && specifier && original) {
          const drive = await driveSet.list();
          const entry = getSpecifierForPlugin(specifier) ?? specifier;
          const inDrive = drive.includes(specifier) || drive.includes(entry);
          if (!inDrive) { yield* original.executor.execute(input, ctx); return; }
        }

        if (action === 'list') {
          const drive = await driveSet.list();
          const synced = (name: string, spec: string) => drive.includes(spec) || drive.includes(name);
          for await (const ev of driveTool.executor.execute(input, ctx)) {
            if (ev.type === 'result' && ev.value !== null && typeof ev.value === 'object' && 'loaded' in ev.value) {
              const v = ev.value as Record<string, unknown> & { loaded: { name: string; specifier: string }[] };
              const loaded = v.loaded.map(p => ({ ...p, managedBy: synced(p.name, p.specifier) ? 'google-drive (synced across browsers)' : 'local (this browser only)' }));
              yield { type: 'result', value: { ...v, loaded } };
            } else {
              yield ev;
            }
          }
          return;
        }

        yield* driveTool.executor.execute(input, ctx);
      },
    },
  };
}
