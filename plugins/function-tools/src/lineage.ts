import type { PluginSettings, ToolContext } from '@matatbread/matbot-plugin-api';
import { TOOL_NAME, versionedSubject } from './compile.js';

// Which versions of a function share its grants. A grant names `<name>@<digest>` of the text that was
// compiled, so an edit — the one door the model controls — does not inherit what the reviewed version was
// allowed. That is right for an edit nobody approved, and painful for one the user is watching: every
// change to a function under development asked for its imports and connections again.
//
// So an edit can be PERMITTED to keep the grants: `tool_function.edit`, asked when a function that holds
// something to keep is redefined, with "always, for edits to this function in this session" among the
// answers. A permitted edit links the new version's digest to the lineage it descends from, and every grant
// is filed under the lineage's first digest — so a grant given during development still holds when the
// finished function runs in a background job, which is outside any session.
//
// The links live in this plugin's settings, not on the stored definition: a definition is in `.data`, which
// a `docker-bash` script can write, while settings are mounted read-only there. A version whose text was
// written by anything but a permitted edit has no link, and is its own lineage. The digest is still derived
// from the compiled text at the call, never read back from anywhere.

/** Something a body can use to reach past itself, and so something a grant may have been given for. */
const CAPABILITY = /\bimport\s*\(|\bfetch\b|\bWebSocket\b/;

const linksKey = (name: string): string => `lineage:${name}`;

/** One edited unit's before and after, by the tool name its grants are filed under. */
export interface Edit { tool: string; before: string | undefined; after: string }

export class Lineage {
  private readonly settings: PluginSettings;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  /** The subject `versioned` (`<name>@<digest>`) files its grants under: the root of its lineage. */
  readonly resolve = async (versioned: string): Promise<string> => {
    const name = versioned.slice(0, versioned.lastIndexOf('@'));
    return (await this.links(name))[versioned] ?? versioned;
  };

  /**
   * Ask whether a redefinition keeps the grants, and link the new versions if it may. `what` names the unit
   * asked about (a function, or a package for all its exports). Returns `kept`, `reset` when it was asked
   * and not permitted, or `undefined` when there was nothing to ask: no edit, or nothing a grant could have
   * been given for.
   */
  async carry(ctx: ToolContext, what: { kind: 'function' | 'package'; name: string }, edits: readonly Edit[]): Promise<'kept' | 'reset' | undefined> {
    const pending: { tool: string; root: string; to: string }[] = [];
    for (const e of edits) {
      if (e.before === undefined || e.before === e.after) continue;
      const from = await versionedSubject(e.tool, e.before);
      const root = await this.resolve(from);
      const to   = await versionedSubject(e.tool, e.after);
      if ((await this.links(e.tool))[to] !== undefined) continue;     // a version already permitted, come back to
      if (root === from && !CAPABILITY.test(e.before)) continue;      // nothing a grant could have been given for
      pending.push({ tool: e.tool, root, to });
    }
    if (pending.length === 0) return undefined;

    const who = what.kind === 'function' ? `function "${what.name}"` : `package "${what.name}"`;
    const subject = `${what.name}@session:${ctx.session.id}`;
    const permit = await ctx.gate({
      namespace: TOOL_NAME, gate: 'edit', subject, fallback: false,
      label: `Keep the permissions given to ${who} — its module imports and network connections — for this new version? ` +
             'If not, each is asked about again the first time the new version uses it.',
      standing: [{ subject, label: `Always keep them for edits to ${who} in this session` }],
    });
    if (!permit.allowed) return 'reset';
    for (const p of pending) await this.link(p.tool, p.to, p.root);
    return 'kept';
  }

  private async links(name: string): Promise<Record<string, string>> {
    const v = await this.settings.get<unknown>(linksKey(name));
    return v !== null && typeof v === 'object' ? v as Record<string, string> : {};
  }

  // Read-modify-write of one key, serialised within the process: two permitted edits landing together
  // must not lose one another's link.
  private link(tool: string, to: string, root: string): Promise<void> {
    const run = this.queue.then(async () => {
      await this.settings.set(linksKey(tool), { ...await this.links(tool), [to]: root });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** What a define's result says about the grants, when there was anything to say. */
export function carriedNote(outcome: 'kept' | 'reset' | undefined): string {
  if (outcome === 'kept')  return ' Its permissions were kept.';
  if (outcome === 'reset') return ' Its permissions were not kept: each import or connection it makes will be asked about again.';
  return '';
}
