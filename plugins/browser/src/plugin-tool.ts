import type { Tool, ToolExecutor, ToolResult, ToolResultOf, ToolContext, MatbotPlugin, FormField, Runtime } from '@matatbread/matbot-plugin-api';
import { CONFIRM_YES, CONFIRM_NO } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getRegisteredTools, getRegisteredFrontendPlugins,
         getRegisteredServiceKeys, getHookPlugins, getSystemContextPlugins,
         getSpecifierForPlugin } from '@matatbread/matbot-core';

/**
 * Persistence of user-added plugin specifiers across realm reloads. The browser has no matbot.yaml,
 * so the bootstrap supplies a small store (its own plugin settings) that survives in IndexedDB and
 * is replayed at boot. `list()` returns the persisted extras; the bootstrap appends the inlined
 * baseline to produce the full configured set.
 */
export interface ExtraPlugins {
  list(): Promise<string[]>;
  add(specifier: string): Promise<void>;
  remove(specifier: string): Promise<void>;
}

type PluginInput =
  | { action: 'list' }
  | { action: 'discover_local' }
  | { action: 'add';       specifier: string }
  | { action: 'remove';    specifier: string }
  | { action: 'reload';    specifier: string }
  | { action: 'store-key'; key: string };

// Baked-but-idle plugins the assembler inlined (config.availablePlugins): present in the artifact +
// import map but not auto-loaded. The browser analogue of node's on-disk `plugins` scan.
interface AvailablePlugin { name: string; specifier: string; matbotRuntime?: string[]; description?: string }

interface ToolSummary { name: string; description: string }

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    plugin:
      | ToolResult<{
          loaded: Array<{
            name:           string;
            apiVersion:     string;
            types:          string[];
            tools:          ToolSummary[];
            specifier:      string;
            description?:   string;
            matbotRuntime?: readonly Runtime[];
          }>;
          configured:   string[];
          builtinTools?: ToolSummary[] | undefined;
        }, { action: 'list' }>
      | ToolResult<AvailablePlugin[], { action: 'discover_local' }>
      | ToolResult<{ message: string; installationMessage?: string }, { action: 'add'       }>
      | ToolResult<{ message: string; installationMessage?: string }, { action: 'remove'    }>
      | ToolResult<{ message: string; installationMessage?: string }, { action: 'reload'    }>
      | ToolResult<{ message: string; installationMessage?: string }, { action: 'store-key' }>;
  }
}

function bakedAvailablePlugins(): AvailablePlugin[] {
  const mb = (globalThis as unknown as { __MB__?: { config?: { availablePlugins?: AvailablePlugin[] } } }).__MB__;
  return mb?.config?.availablePlugins ?? [];
}

async function confirmAction(ctx: ToolContext, label: string): Promise<boolean> {
  const field: FormField = { name: 'confirm', label, type: 'confirm', default: CONFIRM_NO };
  const answer = await ctx.prompt(field);
  return answer.trim().toLowerCase() === CONFIRM_YES;
}

// Reflect every channel a plugin contributes through (mirrors the node plugin tool) so `list` reports
// the complete type set, not just the static fields.
function pluginTypes(p: MatbotPlugin, registeredToolPlugins: Set<string>): string[] {
  const t: string[] = [];
  const serviceKeys = getRegisteredServiceKeys(p.name);

  if (p.provider !== undefined)                                              t.push('provider');
  if (p.tools?.length || registeredToolPlugins.has(p.name))                 t.push('tools');
  if (Object.keys(p.storage ?? {}).length || p.storageBackend !== undefined
      || serviceKeys.includes('StorageBackend'))                            t.push('storage');
  if (getRegisteredFrontendPlugins().has(p.name))                           t.push('frontend');
  if (getHookPlugins().has(p.name))                                         t.push('hooks');
  if (getSystemContextPlugins().has(p.name))                                t.push('system-context');
  t.push(...serviceKeys);
  if (!t.length) t.push('extension');
  return [...new Set(t)];
}

/**
 * The browser `plugin` tool. Unlike the node tool it edits no config file and runs no package
 * manager — there is neither in the browser. `add`/`remove`/`reload` work purely against live
 * specifiers (URL paths or import-map / inlined synthetic ids resolved by the host loader), and the
 * added set is persisted via the injected `extras` store so it survives a realm reload.
 */
export function createBrowserPluginTool(extras: ExtraPlugins): Tool<ToolResultOf<'plugin'>> {
  const executor: ToolExecutor<ToolResultOf<'plugin'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const { action } = input as PluginInput;

      if (action === 'list') {
        const configured = await extras.list();
        const allTools   = getRegisteredTools();
        const toolsByPlugin = new Map<string | undefined, { name: string; description: string }[]>();
        for (const tl of allTools) {
          const list = toolsByPlugin.get(tl.pluginName) ?? [];
          list.push({ name: tl.name, description: tl.description });
          toolsByPlugin.set(tl.pluginName, list);
        }
        const pluginToolNames = new Set(
          [...toolsByPlugin.keys()].filter((k): k is string => k !== undefined),
        );
        const loaded = getRegisteredPlugins().map(p => ({
          name:       p.name,
          apiVersion: p.apiVersion,
          types:      pluginTypes(p, pluginToolNames),
          tools:      toolsByPlugin.get(p.name) ?? [],
          specifier:  p.specifier,
          ...(p.manifest?.description ? { description: p.manifest.description } : {}),
          ...(p.matbotRuntime !== undefined ? { matbotRuntime: p.matbotRuntime } : {}),
        }));
        yield {
          type:  'result',
          value: {
            loaded,
            configured,
            ...(toolsByPlugin.has(undefined) ? { builtinTools: toolsByPlugin.get(undefined) } : {}),
          },
        };
        return;
      }

      if (action === 'discover_local') {
        // Baked-but-idle plugins that aren't already loaded — offered for on-demand activation. Their
        // specifier is the package name, which resolves through the import map to the baked blob (no
        // network) and persists across reloads. Mirrors the node tool's discover_local result shape.
        const loadedNames = new Set(getRegisteredPlugins().map(p => p.name));
        yield { type: 'result', value: bakedAvailablePlugins().filter(p => !loadedNames.has(p.name)) };
        return;
      }

      if (action === 'store-key') {
        const { key } = input as { action: 'store-key'; key: string };
        if (!key || !key.trim()) {
          yield { type: 'error', message: 'store-key requires a "key" name.' };
          return;
        }
        const name    = key.trim();
        const value   = await ctx.prompt(`Enter the value for secret "${name}" (leave blank to remove it; not added to the conversation):`, '');
        const trimmed = value.trim();
        const existed = trimmed === '' && ctx.vault.hasKey(name);
        await ctx.vault.writeSecret(name, trimmed);
        yield { type: 'result', value: { message:
          trimmed !== '' ? `Secret "${name}" stored in the vault.`
          : existed       ? `Secret "${name}" removed from the vault.`
          :                 `No value entered and no secret named "${name}"; nothing changed.` } };
        return;
      }

      const { specifier } = input as { action: string; specifier: string };
      if (!specifier || !specifier.trim()) {
        yield { type: 'error', message: `${action} requires a "specifier".` };
        return;
      }

      if (action === 'add') {
        if ((await extras.list()).includes(specifier)) {
          yield { type: 'result', value: { message: `"${specifier}" is already configured.` } };
          return;
        }
        // Duplicate-name guard: a package.json name is a plugin's identity (and the handle remove/reload
        // use), and the registry forbids two loaded plugins sharing one. Catch the common "add by a name
        // already active" up front with a clear message (a same-package-via-different-URL collision still
        // surfaces, less prettily, as the load error below — persistence only happens after a clean load).
        if (getRegisteredPlugins().some(p => p.name === specifier)) {
          yield { type: 'result', value: { message: `A plugin named "${specifier}" is already active.` } };
          return;
        }
        // Out-of-band confirmation — same security rationale as the node tool: a privileged action
        // must break the LLM's execution chain so a malicious prompt cannot self-install plugins.
        if (!await confirmAction(ctx, `Install plugin **"${specifier}"**?`)) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }
        yield { type: 'stdout', chunk: `Activating "${specifier}"...\n` };
        try {
          const loaded  = await ctx.loadPlugin(specifier);
          // Persist a refresh-stable specifier. A plugin baked into the bundle re-resolves by package
          // name through the import map on *every* boot — and the name is the one specifier common to
          // node and the browser. The raw add specifier may instead be an ephemeral synthetic id
          // (mbmod:, backed by a per-load blob) or an http-only local path, neither of which survives
          // a reload cleanly. So when the loaded plugin's canonical name is itself baked, persist that;
          // otherwise keep the original specifier (a genuinely remote plugin's name isn't baked, so
          // only its URL resolves). Reads the web-bundle payload defensively — absent ⇒ no rewrite.
          const baked = (globalThis as unknown as { __MB__?: { packageEntries?: Record<string, unknown> } })
            .__MB__?.packageEntries ?? {};
          const persistSpec = (loaded.name && baked[loaded.name] !== undefined) ? loaded.name : specifier;
          await extras.add(persistSpec);
          const welcome = await loaded.installationMessage?.();
          yield {
            type:  'result',
            value: {
              message: `"${specifier}" installed and is now active.`,
              ...(welcome !== undefined ? { installationMessage: welcome } : {}),
            },
          };
        } catch (e) {
          yield { type: 'error', message: `Activation of "${specifier}" failed: ${String(e)}` };
        }
        return;
      }

      // A loaded plugin records its configured/extras specifier, so the canonical package name maps to
      // it via getSpecifierForPlugin — accept the name (preferred) or the literal configured specifier.
      const entry = getSpecifierForPlugin(specifier) ?? specifier;

      if (action === 'remove') {
        if (!(await extras.list()).includes(entry)) {
          yield { type: 'result', value: { message: `"${specifier}" is not an installed plugin — pass its package name or its configured specifier (see \`plugin list\`).` } };
          return;
        }
        if (!await confirmAction(ctx, `Remove plugin **"${entry}"**?`)) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }
        yield { type: 'stdout', chunk: `Deactivating "${entry}"...\n` };
        try {
          await ctx.unloadPlugin(entry);
        } catch (e) {
          yield { type: 'stderr', chunk: `Deactivation failed: ${String(e)}\n` };
        }
        await extras.remove(entry);
        yield { type: 'result', value: { message: `"${entry}" removed and deactivated.` } };
        return;
      }

      if (action === 'reload') {
        yield { type: 'stdout', chunk: `Reloading "${entry}"...\n` };
        let wasLoaded: boolean;
        try {
          wasLoaded = await ctx.unloadPlugin(entry);
        } catch (e) {
          yield { type: 'stderr', chunk: `${String(e)}\n` };
          wasLoaded = true;
        }
        if (!wasLoaded && !await confirmAction(ctx, `Plugin **"${entry}"** is not currently loaded — load it now?`)) {
          yield { type: 'result', value: { message: 'Cancelled.' } };
          return;
        }
        const reloaded = await ctx.loadPlugin(entry);
        const welcome  = await reloaded.installationMessage?.();
        yield { type: 'result', value: { message: welcome ?? `"${entry}" reloaded successfully.` } };
        return;
      }

      yield { type: 'error', message: `Unknown action "${String(action)}".` };
    },
  };

  return {
    name:        'plugin',
    description:
      'Manage matbot plugins — the units that contribute tools, providers, storage, hooks, and ' +
      'frontends to the running browser process. List them, install or remove one by specifier, ' +
      'reload one to pick up code changes, or supply a secret a plugin or provider reported missing.\n\n' +
      'This is the browser build: there is no config file and no package manager, so a specifier is ' +
      'a URL path or an inlined synthetic id the host loader can import (not an npm name to install). ' +
      'Added plugins persist across reloads.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type PluginAction =\n' +
      "  | { action: 'list' }                           // configured + loaded plugins, with types and tools\n" +
      "  | { action: 'discover_local' }                 // plugins bundled in this build but not yet loaded; add by the package name they report\n" +
      "  | { action: 'add';        specifier: string }  // activate a plugin (a bundled package name, or a URL to fetch)\n" +
      "  | { action: 'remove';     specifier: string }  // deactivate & forget (specifier = package name, preferred — or its configured specifier)\n" +
      "  | { action: 'reload';     specifier: string }  // re-import (specifier = package name, preferred — or its configured specifier)\n" +
      "  | { action: 'store-key';  key: string };       // store a secret a plugin/provider needs; value entered out-of-band (blank value removes the key)\n" +
      '```\n\n' +
      'For add, a URL specifier is fetched as raw source and MUST resolve a package.json: the URL is one, ' +
      'OR points at a directory containing one, OR is a code entry (…/index.ts) with a package.json as its ' +
      'direct sibling. The package.json must declare a "name"; absence is a hard error.\n\n' +
      'For remove/reload, prefer the plugin\'s canonical package.json **name** (the `name` from `list`) — ' +
      'the configured specifier also works. A name is unique, so it is unambiguous; `add` refuses a second ' +
      'plugin with a name already active.',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:    { type: 'string', enum: ['list', 'discover_local', 'add', 'remove', 'reload', 'store-key'] },
        specifier: { type: 'string', description: 'For remove/reload: the plugin\'s package.json name (preferred — the `name` from `list`) or its configured specifier. For add: a bundled package name, an inlined synthetic id, or a URL to raw source (a package.json, a directory containing one, or a code entry with a sibling package.json that declares a "name").' },
        key:       { type: 'string', description: 'Name of the secret to store (required for store-key); value prompted separately. Entering a blank value removes the key.' },
      },
    },
    executor,
  };
}
