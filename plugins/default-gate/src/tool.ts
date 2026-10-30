import { refusalMessage, type PluginSettings, type Tool, type ToolContext, type ToolContract, type ToolResultOf } from '@matatbread/matbot-plugin-api';
import { DEFAULT_GATE_SETTINGS_NS, denyKey, serialised, toStandingAnswer, type StandingAnswer } from './gate.js';

/** A standing answer in force for one gate: `always` allows every subject, `subjects` allows exactly
 *  those. There is no arm for "no answer" — a gate with none simply is not reported, because an absent
 *  key says nothing about the behaviour. It is not "this will ask": what happens then is the call
 *  site's `fallback` when nobody is reachable, and whatever policy is registered when someone is.
 *  Reporting a row there would be inventing a fact.
 *
 *  What is *in effect*, never what is pinned — a stored answer and an installation's
 *  `default_settings:` floor read identically, because the question a caller has is "will this prompt
 *  appear?" and the two are the same answer to it. */
export interface GateAnswer {
  gate:      string;
  effect:    'always' | 'subjects';
  subjects?: readonly string[];
}

/** One standing answer, addressable on its own: what `list` reports and `clear` takes back by `id`.
 *  `subject` absent means every subject of the gate.
 *
 *  The id is a digest of what the entry IS (allow or deny, gate, subject), not a position or a handle
 *  this tool keeps: so it needs no state between the two calls, the same entry has the same id on every
 *  listing and in every process, and an id that no longer matches anything is an entry that has since
 *  gone — never a different one that took its place. It exists so that nobody has to retype a subject
 *  (`Hubs__check@752dea331e2192f2c8f785579c68829c http://…`) exactly in order to forget it. */
export interface GateEntry {
  id:       string;
  gate:     string;
  effect:   'allow' | 'deny';
  subject?: string;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    gate_action:
      // `denials` is the same shape for what is refused unasked: present only when there is one, so a
      // reader written before denials existed sees exactly the result it always did.
      | ToolContract<{ answers: GateAnswer[]; denials?: GateAnswer[] }, { action: 'get'; gate?: string }>
      | ToolContract<{ entries: GateEntry[] }, { action: 'list'; gate?: string; match?: string }>
      | ToolContract<{ cleared: string[]; message: string }, { action: 'clear'; ids: string[] }>
      | ToolContract<{ cleared: string[]; message: string }, { action: 'clear'; gate?: string; subject?: string }>;
  }
}

type GateInput =
  | { action: 'get';   gate?: string }
  | { action: 'list';  gate?: string; match?: string }
  | { action: 'clear'; gate?: string; subject?: string; ids?: string[] };

// An empty stored list is still an ANSWER — "ask about every subject of this gate" — and is reported
// as such, because it is a thing someone did (cleared the last subject) and a thing `clear` can undo
// back to the installation's configured default. Absent is what goes unreported.
const describe = (gate: string, answer: StandingAnswer | undefined): GateAnswer | undefined =>
  answer === true      ? { gate, effect: 'always' }
  : answer === undefined ? undefined
  :                        { gate, effect: 'subjects', subjects: answer };

const DENY = denyKey('');

/** An entry with the settings key it lives under. */
interface Held extends GateEntry { key: string }

async function entryId(key: string, subject: string | undefined): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([key, subject ?? null])));
  return [...new Uint8Array(digest, 0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function entriesOf(held: Map<string, StandingAnswer>): Promise<Held[]> {
  const out: Held[] = [];
  for (const [key, answer] of held) {
    const deny = key.startsWith(DENY);
    const gate = deny ? key.slice(DENY.length) : key;
    const effect = deny ? 'deny' as const : 'allow' as const;
    for (const subject of answer === true ? [undefined] : answer) {
      out.push({ id: await entryId(key, subject), gate, effect, key, ...(subject !== undefined ? { subject } : {}) });
    }
  }
  return out;
}

const shown = ({ key: _, ...entry }: Held): GateEntry => entry;
const named = (e: GateEntry): string =>
  `${e.effect} ${e.gate} ${e.subject !== undefined ? `"${e.subject}"` : '(every subject)'}`;

export function makeGateActionTool(settings: PluginSettings): Tool<ToolResultOf<'gate_action'>> {
  // Every standing answer in force, in ONE document read: `entries()` layers the stored document over
  // the installation's configured defaults exactly as `get` does, so an answer an install SHIPPED is
  // listed beside one someone gave at a prompt — which no index of "what this code wrote" could ever
  // see. A value that is not a standing answer is simply not one (toStandingAnswer returns undefined),
  // so a stray key in the namespace is never reported as a permission.
  const standing = async (): Promise<Map<string, StandingAnswer>> => {
    const found = new Map<string, StandingAnswer>();
    for (const [gate, value] of Object.entries(await settings.entries())) {
      const answer = toStandingAnswer(value);
      if (answer !== undefined) found.set(gate, answer);
    }
    return found;
  };

  // Re-read inside the write queue the gate's own `remember` uses: the list may have changed since it
  // was read for the listing (an answer given meanwhile, another clear), and writing back a filtered
  // STALE list would restore a subject someone else removed — on an allow list, a grant nobody gave.
  // `whole` deletes the key, reverting to the configured default; otherwise only the named entries go.
  const remove = (key: string, whole: boolean, every: boolean, subjects: ReadonlySet<string>): Promise<void> =>
    serialised(async () => {
      if (whole) { await settings.delete(key); return; }
      const current = toStandingAnswer(await settings.get<unknown>(key));
      if (current === true) { if (every) await settings.delete(key); return; }
      if (current === undefined || !current.some(s => subjects.has(s))) return;
      // Stored, not deleted — including when the list came from `default_settings:`: the result is an
      // override that keeps the rest of the configured list and drops these subjects, which is what was
      // asked for. An empty list is stored too; it means "ask about every subject", a different fact
      // from "revert to whatever the installation configured".
      await settings.set(key, current.filter(s => !subjects.has(s)));
    });

  return {
    name: 'gate_action',
    description:
      'Inspect and forget the standing answers this installation\'s permission policy remembers.\n\n' +
      'A privileged operation — installing a plugin, adding a provider profile, overwriting a tool ' +
      'another plugin owns — asks the user to accept it. Answering "Always allow …" at that prompt ' +
      'stores a standing answer, after which the same operation proceeds silently; answering "Always ' +
      'deny" stores a DENIAL of that exact act, after which it is refused without asking.\n\n' +
      '"list" reports every standing answer as a separate entry with an "id": effect (allow or deny), ' +
      'gate, and subject (absent: every subject of that gate). "match" keeps only entries whose gate or ' +
      'subject contains that text — a host, a URL, a function or plugin name — and "gate" only that ' +
      'gate. Then "clear" with "ids" forgets exactly the entries named. Prefer this to typing a subject: ' +
      'a substring may match more than was meant, so look at what "list" returned before clearing it.\n\n' +
      '"get" reports the same answers grouped by gate, as "answers" and "denials".\n\n' +
      'Both report what is IN EFFECT, whether from a prompt or the installation\'s configured defaults. ' +
      'Gate ids are open — a plugin contributes its own — so there is no vocabulary to list.\n\n' +
      '"clear" without "ids": no arguments forgets every gate, "gate" that gate alone, "gate" + "subject" ' +
      'just that subject. Forgetting a whole gate reverts it to the configured default, so a gate an ' +
      'installation configured keeps that setting.\n\n' +
      'Forgetting a DENIAL asks the user first, since it undoes a refusal they chose; forgetting an ' +
      'allow does not. This tool cannot GRANT permission: the only way to author a standing answer at ' +
      'runtime is to answer a prompt that names the specific act.',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:  { type: 'string', enum: ['get', 'list', 'clear'], description: 'The operation to perform.' },
        gate:    { type: 'string', description: 'A gate id, e.g. "plugin.add" or "tools.overwrite". Absent means every gate. Not with "ids".' },
        match:   { type: 'string', description: 'list only: keep entries whose gate or subject contains this text.' },
        ids:     { type: 'array', items: { type: 'string' }, description: 'clear only: the ids of entries "list" reported, to forget exactly those.' },
        subject: { type: 'string', description: 'clear only: forget just this subject (a tool name, plugin specifier, provider profile, MCP server) rather than the whole gate. Requires "gate". Prefer "ids".' },
      },
    },
    executor: {
      async *execute(input, ctx: ToolContext) {
        const act = input as GateInput;

        if (act.action === 'get') {
          const held    = await standing();
          const gates   = act.gate !== undefined ? [act.gate]
            : [...new Set([...held.keys()].map(k => k.startsWith(DENY) ? k.slice(DENY.length) : k))];
          const rows    = (key: (gate: string) => string): GateAnswer[] =>
            gates.map(gate => describe(gate, held.get(key(gate)))).filter((row): row is GateAnswer => row !== undefined);
          const answers = rows(gate => gate);
          const denials = rows(denyKey);
          yield { type: 'result', value: { answers, ...(denials.length > 0 ? { denials } : {}) } };
          return;
        }

        if (act.action === 'list') {
          // Substring and nothing cleverer: a subject's format is its call site's (a URL, `<fn>@<digest>
          // <origin>`, a specifier), and this policy never parses one — so it cannot offer "every entry
          // for this host" as such, only "every entry that mentions it", which is why it lists rather
          // than clears.
          const entries = (await entriesOf(await standing())).filter(e =>
            (act.gate === undefined || e.gate === act.gate) &&
            (act.match === undefined || e.gate.includes(act.match) || (e.subject?.includes(act.match) ?? false)));
          yield { type: 'result', value: { entries: entries.map(shown) } };
          return;
        }

        if (act.action === 'clear') {
          if (act.ids !== undefined && (act.gate !== undefined || act.subject !== undefined)) {
            yield { type: 'error', message: 'clear: "ids" names the entries to forget on its own — pass it without "gate" or "subject".' };
            return;
          }
          if (act.subject !== undefined && act.gate === undefined) {
            yield { type: 'error', message: 'clear: "subject" identifies a subject WITHIN a gate — pass "gate" as well, or omit "subject" to clear the whole gate.' };
            return;
          }
          const before = await standing();
          const all    = await entriesOf(before);

          let targets: Held[];
          let whole: string[] = [];
          let unknown: string[] = [];
          if (act.ids !== undefined) {
            const ids = new Set(act.ids);
            targets = all.filter(e => ids.has(e.id));
            unknown = [...ids].filter(id => !all.some(e => e.id === id));
          } else if (act.subject !== undefined) {
            // The subject may be allowed, denied, or both (a deny stored first, a broader allow after),
            // and forgetting it means forgetting it wherever it is.
            const keys = [act.gate!, denyKey(act.gate!)];
            targets = all.filter(e => keys.includes(e.key) && e.subject === act.subject);
          } else {
            whole   = act.gate !== undefined ? [act.gate, denyKey(act.gate)].filter(k => before.has(k)) : [...before.keys()];
            targets = all.filter(e => whole.includes(e.key));
          }

          // A denial is a refusal the user chose, so taking one back is theirs to agree to — a model
          // that keeps asking for a refused act would otherwise clear the denial and ask again, and at
          // an unattended door (the HTTP route, a job) the act falls to its site's fallback, which for
          // `tools.overwrite` is to proceed. Forgetting an allow only ever makes a gate ask again, so it
          // is not asked about.
          const kept = new Set<Held>();
          const refusals: string[] = [];
          for (const e of targets) {
            if (e.effect !== 'deny') continue;
            const what = e.subject !== undefined ? `"${e.subject}" at ${e.gate}` : `every ${e.gate}`;
            const decision = await ctx.gate({
              gate: 'forget-denial', subject: e.subject !== undefined ? `${e.key} ${e.subject}` : e.key, fallback: false,
              label: `Forget the standing denial of ${what}? It will no longer be refused without asking.`,
            });
            if (!decision.allowed) { kept.add(e); refusals.push(refusalMessage(decision, `Forget the denial of ${what}`)); }
          }

          for (const key of new Set([...whole, ...targets.map(t => t.key)])) {
            const going = targets.filter(t => t.key === key && !kept.has(t));
            const keepsAny = targets.some(t => t.key === key && kept.has(t));
            await remove(key, whole.includes(key) && !keepsAny, going.some(t => t.subject === undefined),
              new Set(going.flatMap(t => t.subject !== undefined ? [t.subject] : [])));
          }

          // Read back rather than assumed: forgetting what an installation configured reverts to that
          // configuration, which is no change at all, and a list that reported it cleared would look
          // like a success and not be one.
          const after   = await standing();
          const present = new Set((await entriesOf(after)).map(e => e.id));
          const gone    = targets.filter(t => !kept.has(t) && !present.has(t.id));
          const stayed  = targets.filter(t => !kept.has(t) && present.has(t.id));
          const same    = (a: StandingAnswer | undefined, b: StandingAnswer | undefined): boolean =>
            JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

          const cleared = act.ids !== undefined ? gone.map(t => t.id)
            : act.subject !== undefined     ? gone.map(t => `${t.key}:${t.subject ?? ''}`)
            :                                 whole.filter(k => !same(before.get(k), after.get(k)));

          const parts: string[] = [];
          if (gone.length > 0 || cleared.length > 0) {
            parts.push(gone.length > 0
              ? `Forgot ${gone.length} standing answer(s): ${gone.map(named).join('; ')}.`
              : `Forgot ${cleared.join(', ')}.`);
            // Not "will ask again": another entry may still cover the act (a broader subject, an allow
            // of every subject), and only the call site knows how its subjects generalise.
            const left = new Set(gone.map(t => t.gate).filter(g => after.has(g) || after.has(denyKey(g))));
            if (left.size > 0) parts.push(`Other standing answers remain for ${[...left].join(', ')} and still apply; "list" shows them.`);
          }
          if (refusals.length > 0) parts.push(...refusals);
          if (stayed.length > 0) {
            parts.push(`Still in force from the installation's configured defaults, which this tool cannot change: ${stayed.map(named).join('; ')}. Edit \`default_settings\` for '${DEFAULT_GATE_SETTINGS_NS}' to change those.`);
          }
          if (unknown.length > 0) parts.push(`No entry has id ${unknown.join(', ')} — it may have been cleared already; "list" again for current ids.`);
          if (parts.length === 0) {
            // `true` covers every subject, so there is no one subject to subtract — saying so beats
            // silently writing a list that would then shadow the blanket answer the user gave.
            const blanket = act.subject === undefined ? undefined
              : before.get(act.gate!) === true ? 'allowed' : before.get(denyKey(act.gate!)) === true ? 'denied' : undefined;
            parts.push(
              blanket !== undefined ? `"${act.gate}" is ${blanket} for every subject — clear the gate itself to undo that.`
              : act.subject !== undefined && (before.has(act.gate!) || before.has(denyKey(act.gate!)))
                ? `"${act.subject}" is not a remembered subject of "${act.gate}".`
              : act.gate !== undefined ? `"${act.gate}" has no standing answer, so nothing was cleared.`
              : 'No standing answers were stored, so nothing was cleared.');
          }
          yield { type: 'result', value: { cleared, message: parts.join(' ') } };
          return;
        }

        yield { type: 'error', message: `Unknown action "${String((act as { action: unknown }).action)}" — expected "get", "list" or "clear".` };
      },
    },
  };
}
