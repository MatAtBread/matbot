import type { Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-core';
import type { ProfileDirectory } from './backend.js';

// Minimal structural view of the SkillManager service (from @matatbread/matbot-skills), read LOOSELY so
// this plugin needn't depend on skills (offer loosely). `copy` routes skills through save() — under
// runAs(target) it writes into the target partition, emits the change event, AND indexes into the
// KnowledgeIndex, none of which a raw partition doc-copy does. Absent ⇒ skills copy falls back to the
// backend's structural doc copy (correct at rest; surfaces on the next skills reload).
export interface SkillCopier {
  all(): Promise<{ id: string; name: string; content: string; catalogue?: boolean }[]>;
  save(name: string, content: string, catalogue?: boolean): Promise<unknown>;
}

// Copy one skill (by id or name) or the whole set (`*`) from the current principal's partition into
// `target`'s, through the SkillManager so each lands indexed + evented. The target must isolate skills,
// else save() under runAs(target) would route to the shared base and leak the skill to everyone.
async function copySkills(sm: SkillCopier, dir: ProfileDirectory, id: string, target: string): Promise<void> {
  const profile = dir.listProfiles().find(p => p.id === target);
  if (profile === undefined)              throw new Error(`Unknown target profile "${target}".`);
  if (!profile.isolated.includes('skills')) throw new Error(`Profile "${target}" does not isolate "skills", so it already reads the shared base data — nothing to copy into.`);
  const all    = await sm.all();
  const picked = id === '*' ? all : all.filter(s => s.id === id || s.name === id);
  if (picked.length === 0) throw new Error(`No skill "${id}" to copy.`);
  await runAs({ id: target, type: 'user' }, async () => {
    for (const s of picked) await sm.save(s.name, s.content, s.catalogue);
  });
}

// A namespace name in the `profile` contract. Structurally just `string` (callers and generated code pass
// plain strings, and the checker resolves it to `string`), but the *name* survives verbatim into the tool's
// wire description — the flattened TypeScript params/result blocks appended per tool. So `available_namespaces`
// returning `IsolatableNamespace[]` and `create`/`set_isolated` taking `isolated: IsolatableNamespace[]` read
// as one thread: a signal to the model that the former's result is what populates the latter. It carries the
// name, not the values — those come only from calling `available_namespaces`.
type IsolatableNamespace = string;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action. `select` is deliberately absent — selecting the active profile is a
    // per-client concern (the web UI stores it locally and sends it as a request header), not server state.
    profile_action:
      | ToolContract<{ profiles: { name: string; isolated: IsolatableNamespace[] }[] }, { action: 'list' }>
      | ToolContract<{ name: string; isolated: IsolatableNamespace[] },                  { action: 'create'; name: string; isolated?: IsolatableNamespace[] }>
      | ToolContract<{ name: string; deleted: boolean },                                 { action: 'delete'; name: string }>
      | ToolContract<{ done: true },                                                     { action: 'set_isolated'; name: string; isolated: IsolatableNamespace[] }>
      | ToolContract<IsolatableNamespace[],                                              { action: 'available_namespaces' }>;
    // Item-grain sharing across profiles. `action` defaults to `share`. `owner` reports the profile that
    // owns the item this principal would read (null when owned here) — the read-only signal for the UI.
    share:
      | ToolContract<{ shared: true },         { action?: 'share'; namespace: IsolatableNamespace; id: string; target: string }>
      | ToolContract<{ unshared: true },       { action: 'unshare'; namespace: IsolatableNamespace; id: string; target: string }>
      | ToolContract<{ copied: true },         { action: 'copy'; namespace: IsolatableNamespace; id: string; target: string }>
      | ToolContract<{ owner: string | null } | { owners: Record<string, string> }, { action: 'owner'; namespace: IsolatableNamespace; id: string }>;
  }
}

// The directory is resolved live per call (not captured) so the tool follows any later StorageBackend
// swap and never pins a stale/hot-reloaded instance. Absent ⇒ profile storage isn't active right now.
export function createProfileTool(getDir: () => ProfileDirectory | undefined): Tool<ToolResultOf<'profile_action'>> {
  const executor: ToolExecutor<ToolResultOf<'profile_action'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
      const args = input as { action?: string; name?: string; isolated?: string[] };
      const dir  = getDir();
      if (dir === undefined) { yield { type: 'error', message: 'Profile storage is not active.' }; return; }
      switch (args.action) {
        case 'list': {
          yield { type: 'result', value: { profiles: dir.listProfiles().map(p => ({ name: p.name, isolated: p.isolated })) } };
          return;
        }
        case 'available_namespaces': {
          yield { type: 'result', value: dir.availableNamespaces() };
          return;
        }
        case 'create': {
          if (!args.name) { yield { type: 'error', message: 'action "create" requires "name".' }; return; }
          try {
            const p = await dir.createProfile(args.name, args.isolated);
            yield { type: 'result', value: { name: p.name, isolated: p.isolated } };
          } catch (e) {
            yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
          }
          return;
        }
        case 'set_isolated': {
          if (!args.name)               { yield { type: 'error', message: 'action "set_isolated" requires "name".' }; return; }
          if (!Array.isArray(args.isolated)) { yield { type: 'error', message: 'action "set_isolated" requires an "isolated" array of namespaces.' }; return; }
          try {
            await dir.setIsolated(args.name.trim(), args.isolated);
            yield { type: 'result', value: { done: true } };
          } catch (e) {
            yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
          }
          return;
        }
        case 'delete': {
          if (!args.name) { yield { type: 'error', message: 'action "delete" requires "name".' }; return; }
          const name    = args.name.trim();
          const deleted = await dir.deleteProfile(name);
          if (!deleted) { yield { type: 'error', message: `Profile not found: "${name}"` }; return; }
          yield { type: 'result', value: { name, deleted } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, available_namespaces, create, set_isolated, delete.` };
      }
    },
  };

  return {
    name: 'profile_action',
    description:
      'Manage storage profiles — named partitions of the datastore, selected per browser in the web UI. ' +
      'A profile isolates a chosen set of namespaces (its `isolated` list; `sessions` by default) into its ' +
      'own on-disk area, so each profile has independent data for those namespaces; every other namespace — ' +
      'and the default (no profile) — falls through to the shared base storage. Actions: `list` the ' +
      'profiles; `available_namespaces` returns the namespace names that can be isolated (a lower bound — a ' +
      'namespace appears only once something has touched it this session) — call it first to get the values ' +
      'for the `isolated` arrays below; `create` a profile (a filesystem-safe name — letters, digits, ' +
      'underscore, hyphen — with an optional `isolated` override of the default); `set_isolated` to replace ' +
      'a profile\'s isolated set wholesale; `delete` a profile (the ' +
      'registry entry only; its data is left on disk so recreating the name reattaches it). Re-isolating is ' +
      'non-destructive: data already written under the previous routing stays where it was (a dropped ' +
      'namespace\'s partition is orphaned, not migrated). Choosing the active profile is done in the ' +
      'browser, not here — this tool never changes the current selection. The mere presence of this tool ' +
      'is what makes the profile selector appear in the web UI.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:   { type: 'string', enum: ['list', 'available_namespaces', 'create', 'set_isolated', 'delete'], description: 'The operation to perform.' },
        name:     { type: 'string', description: 'Profile name (letters, digits, underscore, hyphen). Required for create/set_isolated/delete.' },
        isolated: { type: 'array', items: { type: 'string' }, description: 'Namespace names (as returned by the `available_namespaces` action) to isolate into this profile. Optional for create (defaults to ["sessions"]); required for set_isolated (replaces the set).' },
      },
    },
    executor,
  };
}

// Companion to the `profile` tool: shares an individual stored item (a session, a fact, …) between
// profiles. Kept a separate tool — sharing is about an item + a target, not the profile registry the
// `profile` tool manages. Resolves the directory live per call, like `profile`.
// The base partition's id is the empty string — the path segment that isn't there, and correct as routing.
// It is not a name, and `null` in this result already means "you own it", so reporting `''` offers two
// readings of one answer with the wrong one the likelier. Rendered only at this boundary, the way the
// ReadOnlyError raised by a refused write to the same item renders the same owner.
const ownerName = (id: string): string => id || 'global';

export function createShareTool(
  getDir:    () => ProfileDirectory | undefined,
  getSkills: () => SkillCopier | undefined,
): Tool<ToolResultOf<'share'>> {
  const executor: ToolExecutor<ToolResultOf<'share'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
      const args = input as { action?: string; namespace?: string; id?: string; target?: string };
      const dir  = getDir();
      if (dir === undefined) { yield { type: 'error', message: 'Profile storage is not active.' }; return; }
      const ns = args.namespace, id = args.id;
      if (!ns || !id) { yield { type: 'error', message: 'share requires "namespace" and "id".' }; return; }
      try {
        switch (args.action ?? 'share') {
          case 'owner': {
            if (id === '*') {
              const owners = Object.entries(await dir.sharedInOwners(ns)).map(([k, v]) => [k, ownerName(v)]);
              yield { type: 'result', value: { owners: Object.fromEntries(owners) } };
              return;
            }
            const owner = await dir.ownerOf(ns, id);
            yield { type: 'result', value: { owner: owner === undefined ? null : ownerName(owner.id) } };
            return;
          }
          case 'unshare': {
            if (!args.target) { yield { type: 'error', message: 'action "unshare" requires "target".' }; return; }
            await dir.unshare(ns, id, args.target.trim());
            yield { type: 'result', value: { unshared: true } };
            return;
          }
          case 'copy': {
            if (!args.target) { yield { type: 'error', message: 'action "copy" requires "target".' }; return; }
            const target = args.target.trim();
            // Skills carry indexed, evented state the SkillManager owns — route them through it so a copy
            // is searchable + live at once; every other namespace is a structural partition copy.
            const sm = getSkills();
            if (ns === 'skills' && sm !== undefined) await copySkills(sm, dir, id, target);
            else                                     await dir.copy(ns, id, target);
            yield { type: 'result', value: { copied: true } };
            return;
          }
          case 'share': {
            if (!args.target) { yield { type: 'error', message: 'share requires "target".' }; return; }
            await dir.share(ns, id, args.target.trim());
            yield { type: 'result', value: { shared: true } };
            return;
          }
          default:
            yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected share, unshare, copy, or owner.` };
        }
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  return {
    name: 'share',
    description:
      'Share a single stored item you own with another storage profile, copy it, or reverse a share. ' +
      'The `namespace` is the ISOLATION axis a profile partitions on (see the `profile` tool\'s ' +
      '`available_namespaces`), NOT a content category. In particular, to share or copy a stored FILE — ' +
      'including a workspace file — always use `namespace: "files"` with `id` set to the file\'s path; do ' +
      'NOT use the file\'s content namespace (e.g. "workspace"), which is not an isolatable axis and cannot ' +
      'be shared. ' +
      '`share` (the default action) exposes the item — e.g. a `sessions` conversation, or a stored file ' +
      '(`namespace: "files"`, `id` = the file path) — read-only in the target profile\'s partition: the target ' +
      'reads your live item, not a copy, and only you can edit it. `unshare` removes that exposure. ' +
      '`copy` instead writes an independent duplicate the target fully owns and can edit (item ids are ' +
      'preserved). `owner` reports which profile owns the item the current profile would read (null when ' +
      'you own it, "global" when it belongs to the shared base rather than to any profile) — the read-only ' +
      'signal; `owner` with `id` of `*` instead returns an `owners` map of ' +
      'every shared-in item in the namespace to its owner, to gate a whole list in one call. For ' +
      'share/unshare/copy an `id` of `*` means the WHOLE namespace (every item in it). Sharing and copying ' +
      'exist only because profiles do; only a namespace ' +
      'the target profile isolates can be shared or copied into (a base/global namespace is already shared ' +
      'by everyone). Names an item by (`namespace`, `id`) and, for share/unshare/copy, a `target` profile.',
    inputSchema: {
      type:       'object',
      required:   ['namespace', 'id'],
      properties: {
        action:    { type: 'string', enum: ['share', 'unshare', 'copy', 'owner'], description: 'Operation to perform; defaults to "share".' },
        namespace: { type: 'string', description: 'Isolation namespace of the item (as listed by profile_action available_namespaces), e.g. "sessions". For any stored file use "files" (not the file\'s content namespace like "workspace").' },
        id:        { type: 'string', description: 'Id of the item, or "*" for the whole namespace (share/unshare/copy; owner returns the shared-in owners map).' },
        target:    { type: 'string', description: 'Target profile name. Required for share, unshare, and copy.' },
      },
    },
    executor,
  };
}
