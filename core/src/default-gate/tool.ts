import { refusalMessage, type PluginSettings, type Tool, type ToolContext, type ToolContract, type ToolResultOf } from '@matatbread/matbot-plugin-api';
import { DEFAULT_GATE_SETTINGS_NS, EVERYWHERE, denyKey, isPolicyOption, migratedFor, serialised, sessionMemory, toScopedAnswers, type ScopedAnswers, type StandingAnswer } from './gate.js';

/** A standing answer in force for one gate in one scope: `always` allows every subject, `subjects` allows
 *  exactly those. There is no arm for "no answer" — a gate with none simply is not reported, because an
 *  absent key says nothing about the behaviour. It is not "this will ask": what happens then is the call
 *  site's `fallback` when nobody is reachable, and whatever policy is registered when someone is.
 *  Reporting a row there would be inventing a fact.
 *
 *  `session` absent means everywhere; present, the answer holds only in that session (or at that door, for a
 *  `#` sentinel such as `#http`). `inMemory` marks a session answer kept in this process, which a restart
 *  forgets.
 *
 *  What is *in effect*, never what is pinned — a stored answer and an installation's
 *  `default_settings:` floor read identically, because the question a caller has is "will this prompt
 *  appear?" and the two are the same answer to it. */
export interface GateAnswer {
  gate:      string;
  effect:    'always' | 'subjects';
  subjects?: readonly string[];
  session?:  string;
  inMemory?: true;
}

/** One standing answer, addressable on its own: what `list` reports and `clear` takes back by `id`.
 *  `subject` absent means every subject of the gate; `session` and `inMemory` as for {@link GateAnswer}.
 *
 *  The id is a digest of what the entry IS (allow or deny, gate, scope, subject, where it is kept), not a
 *  position or a handle this tool keeps: so it needs no state between the two calls, the same entry has the
 *  same id on every listing, and an id that no longer matches anything is an entry that has since gone —
 *  never a different one that took its place. It exists so that nobody has to retype a subject
 *  (`Hubs__check@752dea331e2192f2c8f785579c68829c http://…`) exactly in order to forget it. */
export interface GateEntry {
  id:        string;
  gate:      string;
  effect:    'allow' | 'deny';
  session?:  string;
  inMemory?: true;
  subject?:  string;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    gate_action:
      // `denials` is the same shape for what is refused unasked: present only when there is one.
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

const DENY = denyKey('');
const gateOf = (key: string): string => key.startsWith(DENY) ? key.slice(DENY.length) : key;

/** One scope of one key, from settings or from this process's session memory. */
interface Row { key: string; scope: string; answer: StandingAnswer; inMemory: boolean }

/** An entry with where it lives. */
interface Held extends GateEntry { key: string; scope: string; memory: boolean }

const scoped = (scope: string, memory: boolean): Pick<GateEntry, 'session' | 'inMemory'> => ({
  ...(scope !== EVERYWHERE ? { session: scope } : {}),
  ...(memory ? { inMemory: true as const } : {}),
});

// An empty stored list is still an ANSWER — "ask about every subject of this gate" — and is reported
// as such, because it is a thing someone did (cleared the last subject) and a thing `clear` can undo
// back to the installation's configured default.
const describe = (row: Row): GateAnswer => ({
  gate: gateOf(row.key),
  ...(row.answer === true ? { effect: 'always' as const } : { effect: 'subjects' as const, subjects: row.answer }),
  ...scoped(row.scope, row.inMemory),
});

async function entryId(row: Row, subject: string | undefined): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([row.key, row.scope, subject ?? null, row.inMemory])));
  return [...new Uint8Array(digest, 0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function entriesOf(rows: readonly Row[]): Promise<Held[]> {
  const out: Held[] = [];
  for (const row of rows) {
    const effect = row.key.startsWith(DENY) ? 'deny' as const : 'allow' as const;
    for (const subject of row.answer === true ? [undefined] : row.answer) {
      out.push({
        id: await entryId(row, subject), gate: gateOf(row.key), effect, ...scoped(row.scope, row.inMemory),
        ...(subject !== undefined ? { subject } : {}),
        key: row.key, scope: row.scope, memory: row.inMemory,
      });
    }
  }
  return out;
}

const shown = ({ key: _k, scope: _s, memory: _m, ...entry }: Held): GateEntry => entry;
const named = (e: GateEntry): string =>
  `${e.effect} ${e.gate} ${e.subject !== undefined ? `"${e.subject}"` : '(every subject)'}` +
  (e.session !== undefined ? ` in ${e.session}` : '');

export function makeGateActionTool(settings: PluginSettings): Tool<ToolResultOf<'gate_action'>> {
  // Every standing answer in force in settings, in ONE document read: `entries()` layers the stored document
  // over the installation's configured defaults exactly as `get` does, so an answer an install SHIPPED is
  // listed beside one someone gave at a prompt. A value that is not a scoped answer is simply not one, so a
  // stray key (or one of the policy's own `#` options) is never reported as a permission.
  const stored = async (): Promise<Map<string, ScopedAnswers>> => {
    const found = new Map<string, ScopedAnswers>();
    for (const [key, value] of Object.entries(await settings.entries())) {
      if (isPolicyOption(key)) continue;
      const answers = toScopedAnswers(value);
      if (answers !== undefined) found.set(key, answers);
    }
    return found;
  };

  // Settings first, then this principal's session answers held in memory.
  const rowsOf = (held: Map<string, ScopedAnswers>): Row[] => [
    ...[...held].flatMap(([key, answers]) => [...answers].map(([scope, answer]) => ({ key, scope, answer, inMemory: false }))),
    ...[...sessionMemory()].flatMap(([scope, keys]) => [...keys].map(([key, answer]) => ({ key, scope, answer, inMemory: true }))),
  ];

  // Re-read inside the write queue the gate's own writes use: the answers may have changed since they were
  // read for the listing (an answer given meanwhile, another clear), and writing back a filtered STALE map
  // would restore a subject someone else removed — on an allow, a grant nobody gave. `whole` deletes the key,
  // reverting to the configured default; otherwise only the named subjects go, scope by scope, and a scope
  // allowing every subject goes only when that is what was named.
  interface Removal { every: boolean; subjects: Set<string> }
  const removeStored = (key: string, whole: boolean, scopes: ReadonlyMap<string, Removal>): Promise<void> =>
    serialised(async () => {
      if (whole) { await settings.delete(key); return; }
      const current = toScopedAnswers(await settings.get<unknown>(key));
      if (current === undefined) return;
      const next = new Map(current);
      for (const [scope, { every, subjects }] of scopes) {
        const answer = next.get(scope);
        if (answer === true) { if (every) next.delete(scope); continue; }
        if (answer !== undefined) next.set(scope, answer.filter(s => !subjects.has(s)));
      }
      // Stored, not deleted — including when the answers came from `default_settings:`: the result is an
      // override that keeps the rest and drops these subjects, which is what was asked for. An empty list is
      // stored too; it means "ask about every subject", a different fact from "revert to the configured
      // default".
      // A key left with no scope at all held only "every subject" answers, and forgetting those reverts to
      // the configured default, as forgetting the whole gate does.
      if (next.size === 0) await settings.delete(key);
      else if (JSON.stringify([...next]) !== JSON.stringify([...current])) await settings.set(key, Object.fromEntries(next));
    });

  const removeHeld = (key: string, whole: boolean, scopes: ReadonlyMap<string, Removal>): void => {
    for (const [scope, keys] of sessionMemory()) {
      const answer = keys.get(key);
      if (answer === undefined) continue;
      const named = scopes.get(scope);
      // Nothing to revert to in memory, so an emptied answer goes rather than staying as "ask".
      const next = whole || answer === true ? (whole || named?.every === true ? [] : answer)
        : named !== undefined ? answer.filter(s => !named.subjects.has(s)) : answer;
      if (next !== true && next.length === 0) keys.delete(key); else keys.set(key, next);
      if (keys.size === 0) sessionMemory().delete(scope);
    }
  };

  return {
    name: 'gate_action',
    description:
      'Inspect and forget the standing answers this installation\'s permission policy remembers.\n\n' +
      'A privileged operation — installing a plugin, adding a provider profile, overwriting a tool ' +
      'another plugin owns, a function reading a directory — asks the user to accept it. Answering ' +
      '"Always allow …" stores a standing answer, after which the same operation proceeds silently ' +
      'everywhere; answering "Allow … for this session" stores one that holds only in that conversation. ' +
      'Denials are stored the same way, after which the act is refused without asking.\n\n' +
      '"list" reports every standing answer as a separate entry with an "id": effect (allow or deny), ' +
      'gate, subject (absent: every subject of that gate) and, for one held in a single session, "session" ' +
      '(and "inMemory" when matbot keeps it only until it restarts). "match" keeps only entries whose gate, ' +
      'subject or session contains that text — a host, a URL, a function or plugin name — and "gate" only ' +
      'that gate. Then "clear" with "ids" forgets exactly the entries named. Prefer this to typing a subject: ' +
      'a substring may match more than was meant, so look at what "list" returned before clearing it.\n\n' +
      '"get" reports the same answers grouped by gate and scope, as "answers" and "denials".\n\n' +
      'Both report what is IN EFFECT, whether from a prompt or the installation\'s configured defaults. ' +
      'Gate ids are open — a plugin contributes its own — so there is no vocabulary to list.\n\n' +
      '"clear" without "ids": no arguments forgets every gate, "gate" that gate alone, "gate" + "subject" ' +
      'just that subject, in every session. Forgetting a whole gate reverts it to the configured default, ' +
      'so a gate an installation configured keeps that setting.\n\n' +
      'Forgetting a DENIAL asks the user first, since it undoes a refusal they chose; forgetting an ' +
      'allow does not. This tool cannot GRANT permission: the only way to author a standing answer at ' +
      'runtime is to answer a prompt that names the specific act.',
    inputSchema: {
      type:     'object',
      required: ['action'],
      properties: {
        action:  { type: 'string', enum: ['get', 'list', 'clear'], description: 'The operation to perform.' },
        gate:    { type: 'string', description: 'A gate id, e.g. "plugin.add" or "tools.overwrite". Absent means every gate. Not with "ids".' },
        match:   { type: 'string', description: 'list only: keep entries whose gate, subject or session contains this text.' },
        ids:     { type: 'array', items: { type: 'string' }, description: 'clear only: the ids of entries "list" reported, to forget exactly those.' },
        subject: { type: 'string', description: 'clear only: forget just this subject (a tool name, plugin specifier, provider profile, MCP server) rather than the whole gate. Requires "gate". Prefer "ids".' },
      },
    },
    executor: {
      async *execute(input, ctx: ToolContext) {
        const act = input as GateInput;
        await migratedFor(settings);

        if (act.action === 'get') {
          const rows = rowsOf(await stored()).filter(r => act.gate === undefined || gateOf(r.key) === act.gate);
          const answers = rows.filter(r => !r.key.startsWith(DENY)).map(describe);
          const denials = rows.filter(r => r.key.startsWith(DENY)).map(describe);
          yield { type: 'result', value: { answers, ...(denials.length > 0 ? { denials } : {}) } };
          return;
        }

        if (act.action === 'list') {
          // Substring and nothing cleverer: a subject's format is its call site's (a URL, `<fn>@<digest>
          // <origin>`, a specifier), and this policy never parses one — so it cannot offer "every entry
          // for this host" as such, only "every entry that mentions it", which is why it lists rather
          // than clears.
          const has = (s: string | undefined): boolean => act.match !== undefined && (s?.includes(act.match) ?? false);
          const entries = (await entriesOf(rowsOf(await stored()))).filter(e =>
            (act.gate === undefined || e.gate === act.gate) &&
            (act.match === undefined || has(e.gate) || has(e.subject) || has(e.session)));
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
          const before = await stored();
          const all    = await entriesOf(rowsOf(before));
          const held   = new Set(rowsOf(before).filter(r => r.inMemory).map(r => r.key));

          let targets: Held[];
          let whole: string[] = [];
          let unknown: string[] = [];
          if (act.ids !== undefined) {
            const ids = new Set(act.ids);
            targets = all.filter(e => ids.has(e.id));
            unknown = [...ids].filter(id => !all.some(e => e.id === id));
          } else if (act.subject !== undefined) {
            // The subject may be allowed, denied, or both, in any scope, and forgetting it means
            // forgetting it wherever it is.
            const keys = [act.gate!, denyKey(act.gate!)];
            targets = all.filter(e => keys.includes(e.key) && e.subject === act.subject);
          } else {
            const keys = new Set([...before.keys(), ...held]);
            whole   = act.gate !== undefined ? [act.gate, denyKey(act.gate)].filter(k => keys.has(k)) : [...keys];
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
            const what = (e.subject !== undefined ? `"${e.subject}" at ${e.gate}` : `every ${e.gate}`) +
                         (e.session !== undefined ? ` in ${e.session}` : '');
            const decision = await ctx.gate({
              gate: 'forget-denial', subject: e.subject !== undefined ? `${e.key} ${e.subject}` : e.key, fallback: false,
              label: `Forget the standing denial of ${what}? It will no longer be refused without asking.`,
            });
            if (!decision.allowed) { kept.add(e); refusals.push(refusalMessage(decision, `Forget the denial of ${what}`)); }
          }

          for (const key of new Set([...whole, ...targets.map(t => t.key)])) {
            const ofKey = targets.filter(t => t.key === key);
            const keepsAny = ofKey.some(t => kept.has(t));
            const removal = (memory: boolean): Map<string, Removal> => {
              const scopes = new Map<string, Removal>();
              for (const t of ofKey) {
                if (kept.has(t) || t.memory !== memory) continue;
                const r = scopes.get(t.scope) ?? { every: false, subjects: new Set<string>() };
                if (t.subject === undefined) r.every = true; else r.subjects.add(t.subject);
                scopes.set(t.scope, r);
              }
              return scopes;
            };
            const all = whole.includes(key) && !keepsAny;
            await removeStored(key, all && before.has(key), removal(false));
            removeHeld(key, all, removal(true));
          }

          // Read back rather than assumed: forgetting what an installation configured reverts to that
          // configuration, which is no change at all, and a list that reported it cleared would look
          // like a success and not be one.
          const after   = await stored();
          const now     = await entriesOf(rowsOf(after));
          const present = new Set(now.map(e => e.id));
          const gone    = targets.filter(t => !kept.has(t) && !present.has(t.id));
          const stayed  = targets.filter(t => !kept.has(t) && present.has(t.id));
          const same    = (a: ScopedAnswers | undefined, b: ScopedAnswers | undefined): boolean =>
            JSON.stringify(a !== undefined ? [...a] : null) === JSON.stringify(b !== undefined ? [...b] : null);

          const cleared = act.ids !== undefined ? gone.map(t => t.id)
            : act.subject !== undefined     ? gone.map(t => `${t.key}:${t.subject ?? ''}`)
            :                                 whole.filter(k => held.has(k) || !same(before.get(k), after.get(k)));

          const parts: string[] = [];
          if (gone.length > 0 || cleared.length > 0) {
            parts.push(gone.length > 0
              ? `Forgot ${gone.length} standing answer(s): ${gone.map(named).join('; ')}.`
              : `Forgot ${cleared.join(', ')}.`);
            // Not "will ask again": another entry may still cover the act (a broader subject, an allow
            // of every subject), and only the call site knows how its subjects generalise.
            const left = new Set(gone.map(t => t.gate).filter(g => now.some(e => e.gate === g)));
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
            const ofGate = act.gate !== undefined ? all.filter(e => e.gate === act.gate) : [];
            const blanket = act.subject === undefined ? undefined
              : ofGate.some(e => e.effect === 'allow' && e.subject === undefined) ? 'allowed'
              : ofGate.some(e => e.effect === 'deny'  && e.subject === undefined) ? 'denied' : undefined;
            parts.push(
              blanket !== undefined ? `"${act.gate}" is ${blanket} for every subject — clear the gate itself to undo that.`
              : act.subject !== undefined && ofGate.length > 0
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
