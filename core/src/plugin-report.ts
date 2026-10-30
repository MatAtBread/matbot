import type { MatbotPlugin, PluginListResult, ToolContext, ToolSummary } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getRegisteredTools, getRegisteredFrontendPlugins, getRegisteredServiceKeys,
         getHookPlugins, getSystemContextPlugins, getFailedPlugins } from './registry.js';

// What the two `plugin` tools — node's in tool-plugin, the browser's in plugins/browser — answer the same
// way: everything read from the registries and the vault, rather than from a config file, a package
// manager or an import map. Each was a copy of the other.

// Every channel a plugin contributes through, reflected from the registries rather than declared.
function pluginTypes(p: MatbotPlugin, toolPlugins: ReadonlySet<string>): string[] {
  const t: string[] = [];
  const serviceKeys = getRegisteredServiceKeys(p.name);

  if (p.provider !== undefined)                                                 t.push('provider');
  if (p.tools?.length || toolPlugins.has(p.name))                               t.push('tools');
  if (p.storageBackend !== undefined || serviceKeys.includes('StorageBackend')) t.push('storage');
  if (getRegisteredFrontendPlugins().has(p.name))                               t.push('frontend');
  if (getHookPlugins().has(p.name))                                             t.push('hooks');
  if (getSystemContextPlugins().has(p.name))                                    t.push('system-context');
  // Any other runtime-registered service (custom cognitive subsystems, domain backends).
  t.push(...serviceKeys);

  if (!t.length) t.push('extension');
  return [...new Set(t)];
}

/** `plugin list`, less the two things only a host knows: what its configuration names, and whether a
 *  host singleton has a second copy. */
export function describePlugins(): Omit<PluginListResult, 'configured' | 'duplicateSingletons'> {
  // Grouped by owning plugin; `undefined` is a tool the host registered.
  const toolsByPlugin = new Map<string | undefined, ToolSummary[]>();
  for (const t of getRegisteredTools()) {
    const list = toolsByPlugin.get(t.pluginName) ?? [];
    list.push({ name: t.name, description: t.description });
    toolsByPlugin.set(t.pluginName, list);
  }
  const toolPlugins = new Set([...toolsByPlugin.keys()].filter((k): k is string => k !== undefined));

  const loaded = getRegisteredPlugins().map(p => ({
    name:        p.name,
    apiVersion:  p.apiVersion,
    types:       pluginTypes(p, toolPlugins),
    tools:       toolsByPlugin.get(p.name) ?? [],
    specifier:   p.specifier,
    ...(p.version       !== undefined ? { version:       p.version }       : {}),
    ...(p.resolvedUrl   !== undefined ? { resolvedUrl:   p.resolvedUrl }   : {}),
    ...(p.manifest?.description ? { description: p.manifest.description } : {}),
    ...(p.matbotRuntime !== undefined ? { matbotRuntime: p.matbotRuntime } : {}),
  }));
  const failed = getFailedPlugins();
  return {
    loaded,
    ...(failed.length ? { failed: failed.map(f => ({ specifier: f.specifier, error: f.error, ...(f.name !== undefined ? { name: f.name } : {}) })) } : {}),
    ...(toolsByPlugin.has(undefined) ? { builtinTools: toolsByPlugin.get(undefined) } : {}),
  };
}

/**
 * `plugin store-key`: a plugin or provider that needs a secret raises `MissingSecretError` naming the key,
 * and this supplies it. The value is asked for out-of-band, so it never enters the transcript; a blank
 * answer removes the key.
 */
export async function storeSecret(ctx: Pick<ToolContext, 'prompt' | 'vault'>, key: string | undefined): Promise<{ message: string } | { error: string }> {
  if (!key || !key.trim()) return { error: 'store-key requires a "key" name.' };
  const name    = key.trim();
  const value   = await ctx.prompt(`Enter the value for secret "${name}" (leave blank to remove it; not added to the conversation):`, '');
  const trimmed = value.trim();
  // writeSecret, not createSecret: this answers a MissingSecretError naming an exact key, so the value
  // must land under that name verbatim — no reference/dedup canonicalisation. An empty value is
  // writeSecret's removal signal.
  const existed = trimmed === '' && ctx.vault.hasKey(name);
  await ctx.vault.writeSecret(name, trimmed);
  return { message:
    trimmed !== '' ? `Secret "${name}" stored in the vault.`
    : existed       ? `Secret "${name}" removed from the vault.`
    :                 `No value entered and no secret named "${name}"; nothing changed.` };
}
