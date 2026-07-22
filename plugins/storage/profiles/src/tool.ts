import type { Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext } from '@matatbread/matbot-plugin-api';
import type { ProfileDirectory } from './backend.js';

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
    profile:
      | ToolContract<{ profiles: { name: string; isolated: IsolatableNamespace[] }[] }, { action: 'list' }>
      | ToolContract<{ name: string; isolated: IsolatableNamespace[] },                  { action: 'create'; name: string; isolated?: IsolatableNamespace[] }>
      | ToolContract<{ name: string; deleted: boolean },                                 { action: 'delete'; name: string }>
      | ToolContract<{ done: true },                                                     { action: 'set_isolated'; name: string; isolated: IsolatableNamespace[] }>
      | ToolContract<IsolatableNamespace[],                                              { action: 'available_namespaces' }>;
  }
}

// The directory is resolved live per call (not captured) so the tool follows any later StorageBackend
// swap and never pins a stale/hot-reloaded instance. Absent ⇒ profile storage isn't active right now.
export function createProfileTool(getDir: () => ProfileDirectory | undefined): Tool<ToolResultOf<'profile'>> {
  const executor: ToolExecutor<ToolResultOf<'profile'>> = {
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
    name: 'profile',
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
