import type { ToolContext, ToolEvent, ToolResultOf } from '@matatbread/matbot-core';
import { refusalMessage, clearFailedPlugin, getPluginNameForSpecifier } from '@matatbread/matbot-core';
import path from 'node:path';
import { classifySpecifier, releaseRemote } from '../../remote-cache.js';
import { removeProvisioned, runCommand }     from '../../provision.js';
import { readInstallRecord, dropInstallRecord, declaredDependencies } from '../../install-record.js';
import { readPluginsList, removePluginEntry, otherRemotes } from '../../config-entries.js';
import { detectPackageManager }              from '../../package-manager.js';
import { forgetLoaded }                      from '../../fingerprint.js';
import { nameFromSpecifier, toConfigSpecifier } from './identity.js';

export async function* removePlugin(configPath: string, specifier: string, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const projectDir = path.dirname(configPath);
  const existing = await readPluginsList(configPath);
  // Address a plugin by its canonical package name (preferred) or its exact matbot.yaml entry.
  const entry = toConfigSpecifier(specifier);
  if (!existing.includes(entry)) {
    yield { type: 'result', value: { message: `"${specifier}" is not an installed plugin — pass its package name or its matbot.yaml entry (see \`plugin list\`).` } };
    return;
  }

  // Same security rationale as add: out-of-band prompt, not a confirmable parameter.
  const permit = await ctx.gate({ gate: 'remove', subject: entry, fallback: false,
                                  label: `Remove plugin **"${entry}"**?` });
  if (!permit.allowed) {
    yield { type: 'result', value: { message: refusalMessage(permit) } };
    return;
  }

  const removed = await removePluginEntry(configPath, entry);
  if (!removed) {
    yield { type: 'error', message: `Failed to remove "${entry}" from ${path.basename(configPath)}.` };
    return;
  }

  // A configured plugin that never loaded (a bad path, an incompatible runtime, a setup() throw)
  // has a recorded load failure but no live registration. Removing it from config must also drop
  // that failure record, or it lingers in `plugin list` / the web UI as a ghost with no config entry.
  clearFailedPlugin(entry);

  // Capture the canonical package name before deactivation drops it from the registry: it names the
  // package in what is said below. Falls back to a disk walk for a configured-but-unloaded plugin.
  const pkgName = getPluginNameForSpecifier(entry) ?? await nameFromSpecifier(entry, projectDir);
  const dotPlugins = path.join(projectDir, '.plugins');
  const record = await readInstallRecord(dotPlugins, entry);

  yield { type: 'stdout', chunk: `Deactivating "${entry}"...\n` };
  try {
    await ctx.unloadPlugin(entry);
  } catch (e) {
    yield { type: 'stderr', chunk: `Deactivation failed: ${String(e)}\n` };
  }

  // A fetched plugin's cache is matbot's own, and the plugin is gone: its source, the dependencies
  // installed into it, a set-aside copy and its name link go with it, unasked. Left, the name link kept
  // a removed plugin importable by name.
  if ((await classifySpecifier(entry, projectDir)).kind === 'http'
      && await releaseRemote(entry, dotPlugins, await otherRemotes(configPath, projectDir, entry))) {
    yield { type: 'stdout', chunk: `Removed its cached copy and installed dependencies from .plugins/.\n` };
  }

  // What `add` changed in the PROJECT is offered back, and only what the install record says `add`
  // created. Whether the project declares the package now is no evidence of who put it there: read that
  // way, `remove` offered to uninstall a project's own peer dependency.
  if (record?.dependency !== undefined) {
    const offer = await ctx.gate({ gate: 'npm-uninstall', subject: record.dependency, fallback: false,
                                   label: `Also uninstall the npm package **"${record.dependency}"** that adding the plugin installed?` });
    if (offer.allowed) {
      try {
        const out = await runCommand(await detectPackageManager(projectDir), ['remove', record.dependency], projectDir);
        if (out) yield { type: 'stdout', chunk: out };
      } catch (e) {
        yield { type: 'stderr', chunk: `Uninstall failed: ${String(e)}\n` };
      }
    }
  } else if (pkgName !== undefined && (await declaredDependencies(projectDir))?.has(pkgName) === true) {
    yield { type: 'stdout', chunk:
      `"${pkgName}" stays in package.json: no record says \`plugin add\` installed it, so it is the project's ` +
      `to remove (\`${await detectPackageManager(projectDir)} remove ${pkgName}\`).\n` };
  }
  if (record?.provisioned !== undefined) {
    const what = [record.provisioned.nodeModules ? 'node_modules' : '', record.provisioned.lockfile ? 'package-lock.json' : '']
      .filter(Boolean).join(' and ');
    if (what !== '') {
      const offer = await ctx.gate({ gate: 'remove-provisioned', subject: record.provisioned.dir, fallback: false,
                                     label: `Also delete the ${what} that adding the plugin created in **${record.provisioned.dir}**?` });
      if (offer.allowed) {
        const removed = await removeProvisioned(record.provisioned);
        yield { type: 'stdout', chunk: `Removed ${removed.join(' and ')} from ${record.provisioned.dir}.\n` };
      }
    }
  }
  await dropInstallRecord(dotPlugins, entry);
  forgetLoaded(entry);

  yield { type: 'result', value: { message: `"${entry}" removed and deactivated.` } };
}
