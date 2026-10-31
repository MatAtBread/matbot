import type { ToolContext, ToolEvent, ToolResultOf, PermissionDecision } from '@matatbread/matbot-core';
import { refusalMessage } from '@matatbread/matbot-core';
import { readFile }       from 'node:fs/promises';
import path               from 'node:path';
import { classifySpecifier, materializeRemote, restoreRemote, discardRestore,
         type MaterializedRemote } from '../../remote-cache.js';
import { planRemoteProvision, applyRemoteProvision, discardRemoteProvision,
         type ProvisionPlan } from '../../provision.js';
import { fingerprintDir, loadedFingerprint, pluginFingerprint } from '../../fingerprint.js';
import { toConfigSpecifier } from './identity.js';

// `refresh` (the tool defaults it to true): for a remote (github/http) plugin, reload means "pick up the
// latest upstream source" — the cross-source analog of how a local reload always reflects on-disk edits.
// refresh=false re-runs setup() against the cached copy (e.g. to reset state, or offline).
export async function* reloadPlugin(configPath: string, specifier: string, refresh: boolean, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const projectDir = path.dirname(configPath);
  // Accept the canonical package name or the matbot.yaml entry; a not-yet-loaded direct specifier
  // falls through unchanged (the first-time-load path below).
  const entry = toConfigSpecifier(specifier);
  yield { type: 'stdout', chunk: `Reloading "${entry}"...\n` };

  const dotPlugins = path.join(projectDir, '.plugins');
  // Only a fetched plugin has a refresh to undo: a local reload reflects on-disk edits and an npm one
  // re-imports node_modules, neither of which this path writes to or evicts.
  const refreshed = refresh && (await classifySpecifier(entry, projectDir)).kind === 'http';

  // Code that is already on disk is checked before anything is unloaded, so a refusal leaves the
  // plugin running as it was. A refresh is checked once fetched, below, where a refusal restores the
  // cached copy instead.
  if (!refreshed) {
    const permit = await approveNewCode(ctx, entry, pluginFingerprint(entry, projectDir));
    if (permit !== undefined && !permit.allowed) {
      yield { type: 'result', value: { message: refusalMessage(permit, `Reloading "${entry}" with its changed code`) } };
      return;
    }
  }

  let wasLoaded: boolean;
  try {
    wasLoaded = await ctx.unloadPlugin(entry);
  } catch (e) {
    // teardown() failed (e.g. timeout) — the plugin was resident, so this is still a
    // genuine reload of already-trusted code; surface the error but proceed.
    yield { type: 'stderr', chunk: `${String(e)}\n` };
    wasLoaded = true;
  }

  // Reloading a resident plugin's unchanged code needs no confirmation — that code is what was approved
  // (changed code was asked about above). But if nothing was unloaded, "reload" is really a first-time
  // load of code they haven't consented to, so gate it with the same confirmation as add/remove.
  if (!wasLoaded) {
    const permit = await ctx.gate({ gate: 'load', subject: entry, fallback: false,
                                    label: `Plugin **"${entry}"** is not currently loaded — load it now?` });
    if (!permit.allowed) {
      yield { type: 'result', value: { message: refusalMessage(permit) } };
      return;
    }
  }

  // A refresh is fetched HERE, not inside the load, so that a dependency the new copy declares and the
  // cached one never had is offered before anything is loaded — not after a load that was always going to
  // fail on it. Declined or not installed, the new copy is not loaded at all, and the restore below puts
  // the working one back.
  let failure: unknown;
  let installed = 0;
  let ready = true;
  if (refreshed) {
    try {
      const m = await materializeRemote(entry, dotPlugins, projectDir, /* forceRefresh */ true);
      const permit = await approveNewCode(ctx, entry, fingerprintDir(m.pkgRoot));
      if (permit !== undefined && !permit.allowed) throw new Error(refusalMessage(permit, 'Loading its new upstream code'));
      const dep = yield* provisionRemoteDependencies(ctx, entry, m);
      switch (dep.outcome) {
        case 'installed':  installed = dep.packages; break;
        case 'none':       break;
        case 'declined':   ready = false; failure = new Error('the dependencies its new copy declares were not installed'); break;
        case 'unresolved': ready = false; failure = new Error(`the dependencies its new copy declares could not be resolved: ${dep.reason}`); break;
        case 'failed':     ready = false; failure = new Error(`the dependencies its new copy declares did not install: ${dep.reason}`); break;
      }
    } catch (e) {
      ready = false;
      failure = e;
    }
  }
  if (ready) {
    try {
      // Already refreshed above when it was going to be; the load reads the cache.
      const reloaded = await ctx.loadPlugin(entry, false);
      if (refreshed) await discardRestore(entry, dotPlugins);
      const extra  = installed > 0 ? ` (${installed} dependency package(s) installed)` : '';
      const result = await reloaded.installationMessage?.() || `"${entry}" reloaded successfully${extra}.`;
      if (result !== null) {
        yield { type: 'result', value: { message: result } };
      }
      return;
    } catch (e) {
      failure = e;
    }
  }

  // A refresh replaces the cached source, so by now the copy that WAS working is no longer what is on
  // disk — without putting it back, a failed reload is an outage and not a no-op: the plugin stays
  // unloaded and its tools are simply gone.
  if (refreshed && await restoreRemote(entry, dotPlugins)) {
    try {
      await ctx.loadPlugin(entry);
      yield { type: 'result', value: { message:
        `"${entry}" did not reload: ${String(failure)}. The previously cached copy has been restored and is ` +
        `active again, so nothing was lost — fix the cause upstream and reload again.` } };
    } catch (err) {
      yield { type: 'error', message:
        `"${entry}" did not reload: ${String(failure)}. The previously cached copy was restored but did not ` +
        `load either (${String(err)}), so the plugin is not running.` };
    }
    return;
  }

  // Nothing to put back on the other routes: a local plugin's source is whatever is on disk and an
  // npm one's is in node_modules, both untouched here — so the fix is theirs and a reload picks it up.
  yield { type: 'error', message: wasLoaded
    ? `"${entry}" did not reload, and is no longer loaded: ${String(failure)}.`
    : `"${entry}" did not load: ${String(failure)}.` };
}

// ── Provisioning a fetched plugin's dependencies ──────────────────────────────
//
// Offer to install them, rather than only naming them — into the plugin's OWN cached directory under
// `.plugins/`, which is the same place the local route installs into and for the same reasons.
//
// NOT the project. `pnpm add` at a workspace root refuses outright (ERR_PNPM_ADDING_TO_ROOT, wanting
// `-w`), and where it succeeds it writes a fetched plugin's dependencies into the user's own manifest
// and lockfile — permanent, tracked, and nothing to do with their project. The cache directory has none
// of that: it is matbot's to write, gitignored, per-plugin, and it sits EARLIER in the resolution
// walk-up than the shared link farm, so what lands there is reachable from this plugin and invisible to
// everything else. Not the farm itself either, which holds the host singletons and the plugin
// self-links — an install there would prune them as extraneous.
//
// Reusing plan/apply rather than shelling out gets the rest for free: npm unconditionally (the cache dir
// is not in anyone's workspace, so pnpm's walk-up problem cannot arise), the full transitive set in the
// approval instead of just the direct names, and the host singletons linked afterwards. The approval is
// still an out-of-band human one, so a fetched plugin cannot install anything by asserting that it needs
// it.
//
// Every declared dependency is planned, and BEFORE the plugin is loaded: activation stops at the FIRST
// unresolved import, so planning after a failed load was a load that was always going to fail, logged as an
// error, then a second prompt and a retry. `add` folds the plan into the approval for the plugin itself;
// `reload` asks with this, because a refresh can bring a dependency the cached copy never had and the
// plugin's own approval was given long ago. The outcome is returned rather than reported: a tool frames
// itself.
type DepProvision =
  | { outcome: 'none' }                                  // nothing declared that is not already present
  | { outcome: 'unresolved'; reason: string }            // npm could not say what it would install
  | { outcome: 'declined' }
  | { outcome: 'failed';    reason: string }             // the install itself failed
  | { outcome: 'installed'; packages: number };

async function* provisionRemoteDependencies(
  ctx: ToolContext, specifier: string, m: MaterializedRemote,
): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, DepProvision> {
  let plan: ProvisionPlan | undefined;
  try {
    const pkg = JSON.parse(await readFile(path.join(m.pkgRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    plan = await planRemoteProvision(pkg, m.pkgRoot);
  } catch (err) {
    return { outcome: 'unresolved', reason: err instanceof Error ? err.message : String(err) };
  }
  if (plan === undefined) return { outcome: 'none' };
  if (plan.packages.length === 0) {
    await discardRemoteProvision(plan);
    return { outcome: 'none' };
  }

  const offer = await ctx.gate({
    gate:     'provision-deps',
    subject:  specifier,
    fallback: false,
    label:
      `**"${specifier}"** now declares dependencies its cached copy does not have. Install ` +
      `${plan.packages.length} package(s) into its cache directory?\n${plan.packages.map(pkg => `- ${pkg}`).join('\n')}`,
  });
  if (!offer.allowed) {
    await discardRemoteProvision(plan);
    return { outcome: 'declined' };
  }

  yield { type: 'stdout', chunk: `Installing ${plan.packages.length} package(s) with npm...\n` };
  try {
    const { linked, output } = await applyRemoteProvision(plan, m.pkgRoot);
    if (output) yield { type: 'stdout', chunk: output };
    if (linked.length > 0) yield { type: 'stdout', chunk: `Linked the host's ${linked.join(', ')}.\n` };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  return { outcome: 'installed', packages: plan.packages.length };
}

/**
 * The question a reload must ask when the code it would import is not the code that was loaded: anything
 * on disk may have been rewritten since (by `skills_compiler`, or by a script), and a refresh fetches
 * whatever upstream now serves. Undefined when there is nothing to ask — the plugin was never loaded in
 * this process (the `load` gate's question), or its code is unchanged. Code no digest could be taken of
 * counts as changed.
 */
async function approveNewCode(ctx: ToolContext, entry: string, now: Promise<string | undefined>): Promise<PermissionDecision | undefined> {
  const before = loadedFingerprint(entry);
  if (before === undefined) return undefined;
  const [was, is] = await Promise.all([before, now]);
  if (was !== undefined && was === is) return undefined;
  return ctx.gate({
    gate: 'reload', subject: entry, fallback: false,
    label: `The code of plugin **"${entry}"** has changed since it was loaded. Load the new code? It runs with matbot's full access.`,
    standing: [{ subject: entry, label: `Always allow reloading "${entry}" when its code has changed` }],
  });
}
