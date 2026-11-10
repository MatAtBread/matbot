import type { Store, MatbotMachine, Session } from '@matatbread/matbot-plugin-api';
import type { Trigger, TriggerSpec, TriggerSurface, TriggerKind, Triggers, FiredCondition, TriggerFilterContext } from './types.js';
import { surfaceOfKind } from './types.js';

const MAX_MSG_CHARS = 4000;

// The provider name the classifier used to pick up implicitly. It no longer does; setup warns when an
// install still has one and has not pinned it. Removed in 0.6.0, with that warning.
export const RETIRED_CLASSIFIER = 'skills-classifier';
const RETIRED_KIND = 'augment';

function clip(text: string): string {
  if (text.length <= MAX_MSG_CHARS) return text;
  const half = Math.floor((MAX_MSG_CHARS - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
}

/** One side of the exchange shown to the classifier: its text, and the bracketed summary of what else
 *  its turn held (tool calls, files), which the classifier is not shown as content. */
export interface ClassifiedMessage {
  label:    string;
  text:     string;
  summary?: string;
}

// The summary follows the clipped text, so a long message cannot truncate it away.
function render(m: ClassifiedMessage): string {
  const parts = [...(m.text !== '' ? [clip(m.text)] : []), ...(m.summary !== undefined ? [m.summary] : [])];
  return parts.length > 0 ? parts.join('\n\n') : '(none)';
}

// The conditions a classifier reply names as matched, each with its evidence. The reply lists them under
// `matched` (an entry may be a bare id). A model answering in the per-condition shape asked for before 0.5.0
// (`{ "<id>": { "match": true|false, "why": … } }`, or a bare boolean) still counts only an explicit `true`.
function matchesOf(reply: unknown): Map<string, { why?: string }> {
  const out = new Map<string, { why?: string }>();
  if (typeof reply !== 'object' || reply === null) return out;
  const listed = (reply as { matched?: unknown }).matched;
  if (Array.isArray(listed)) {
    for (const e of listed) {
      const { id, why } = typeof e === 'string' ? { id: e, why: undefined } : (e ?? {}) as { id?: unknown; why?: unknown };
      if (typeof id === 'string' && !out.has(id)) out.set(id, typeof why === 'string' ? { why } : {});
    }
    return out;
  }
  for (const [id, v] of Object.entries(reply)) {
    if (v === true) { out.set(id, {}); continue; }
    if (typeof v !== 'object' || v === null || (v as { match?: unknown }).match !== true) continue;
    const why = (v as { why?: unknown }).why;
    out.set(id, typeof why === 'string' ? { why } : {});
  }
  return out;
}

// Each complete JSON object in a reply, in order, outermost only. Not one greedy brace match: a classifier
// that second-guesses itself writes its verdict, some prose ("Wait, let me re-check…") and a corrected
// verdict, and a greedy match spans all of it, which is not JSON, so the turn fired nothing. Each `{` is
// tried as the start of an object (a string-aware scan to its matching `}`), so a stray brace in prose
// costs only itself.
function* jsonObjects(text: string): Generator<unknown> {
  for (let start = text.indexOf('{'); start !== -1; ) {
    const end = closingBrace(text, start);
    if (end !== -1) {
      try {
        yield JSON.parse(text.slice(start, end + 1));
        start = text.indexOf('{', end + 1);
        continue;
      } catch { /* not JSON: try the next brace */ }
    }
    start = text.indexOf('{', start + 1);
  }
}

// The index of the `}` closing the `{` at `start`, skipping braces inside strings; -1 if it never closes.
function closingBrace(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// The verdict a reply ends on: the LAST object listing `matched`, so a correction overrides what it
// corrects; failing that the last object (the 0.4.x per-condition map); `undefined` with no object at all.
function lastVerdict(text: string): unknown {
  let listed: unknown, other: unknown;
  for (const o of jsonObjects(text)) {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) continue;
    if (Array.isArray((o as { matched?: unknown }).matched)) listed = o;
    else other = o;
  }
  return listed ?? other;
}

/** Stable identity for seed idempotency: a trigger is "the same" if it invokes the same tool with
 *  the same params. Triggers carry no name, so the invocation is the natural key. */
function invokeKey(t: { invoke: Trigger['invoke'] }): string {
  return t.invoke.tool + '\u0000' + JSON.stringify(t.invoke.params ?? null);
}

/**
 * Owns the live trigger set: an in-memory list backed by a {@link Store} for persistence. All CRUD
 * goes through here so the plugin's hooks and the `trigger_action` tool share one source of truth.
 * Constructed only with web-platform primitives, so it runs in the browser too.
 */
export class TriggerManager implements Triggers {
  private readonly store:    Store<Trigger>;
  private readonly services: MatbotMachine;
  // Aborts on teardown (clear()), ending the mounted-swap subscription set up in setupTriggers.
  private readonly lifecycle = new AbortController();

  constructor(store: Store<Trigger>, services: MatbotMachine) {
    this.store    = store;
    this.services = services;
  }

  /** Aborts on teardown (clear()) — ends any in-flight classifier call the manager owns. */
  get signal(): AbortSignal { return this.lifecycle.signal; }

  // The classifier provider, resolved live per evaluation (so a triggers_config change takes effect on
  // the next turn): the `classifierProvider` setting if set and valid, else the current turn's own
  // provider. There is always a turn provider to fall back to, so the classifier always has a model —
  // triggers work with zero config.
  async resolveClassifierProvider(turnProvider: string): Promise<string> {
    const pinned = await this.services.settings().get<string>('classifierProvider');
    if (pinned !== undefined && this.services.providers.has(pinned)) return pinned;
    return turnProvider;
  }

  /** Read straight through the backing store on every call — no in-memory snapshot. The store is a
   *  swap-following proxy, so this always reflects the live backend AND the current principal's
   *  partition, and a shared backend's out-of-band writes are seen too. A snapshot here would be
   *  principal-blind and go stale under any second writer; caching, if a slow backend needs it,
   *  belongs in the StorageBackend, not in this consumer. */
  async all(): Promise<Trigger[]> {
    const { items } = await this.store.query({});
    return Promise.all(items.map(t => this.migrated(t)));
  }

  async get(id: string): Promise<Trigger | undefined> {
    const t = await this.store.get(id);
    return t === null ? undefined : this.migrated(t);
  }

  /**
   * `augment` is what `ephemeral` was called before the user-surface kinds became a pair. Unrecognised, a
   * condition of that kind was judged on no surface, so its trigger silently never fired. Read as
   * `ephemeral` and written back on read — not once at setup, because the store is read per principal and
   * a setup pass would migrate only the boot principal's. Said every time one is migrated. The write is a
   * courtesy to the next read, so it never costs this one: a lost CAS, or a refusal (a trigger shared in
   * read-only, which only its owner's next read can store), reads as `ephemeral` all the same. A throw here
   * would reject the whole listing, so none of the principal's triggers would fire. Removed in 0.6.0.
   */
  private async migrated(t: Trigger): Promise<Trigger> {
    if (!t.conditions.some(c => (c.kind as string) === RETIRED_KIND)) return t;
    const next = (cur: Trigger): Trigger => ({
      ...cur, conditions: cur.conditions.map(c => (c.kind as string) === RETIRED_KIND ? { ...c, kind: 'ephemeral' as const } : c),
    });
    const said = `[triggers] Trigger "${t.id}" has a condition of kind "${RETIRED_KIND}", the name "ephemeral" had before 0.5.0; `;
    const later = 'it is read as "ephemeral", and will be stored so when it next can be';
    try {
      const r = await this.store.cas(t.id, t.version, { ...next(t), version: crypto.randomUUID() });
      console.warn(said + (r.ok ? 'it is now stored as "ephemeral".' : `${later}.`));
      return r.ok ? r.doc : next(t);
    } catch (e) {
      console.warn(`${said}${later}: ${e instanceof Error ? e.message : String(e)}`);
      return next(t);
    }
  }

  /** Triggers whose invocation matches the filter: `tool` (if given) must equal `invoke.tool`, and
   *  `params` (if given) must deep-equal `invoke.params`. The natural "which trigger(s) fire tool X
   *  (with these args)" lookup — e.g. the one that loads a given skill. */
  async query(filter: { tool?: string; params?: unknown }): Promise<Trigger[]> {
    return (await this.all()).filter(t => {
      if (filter.tool !== undefined && t.invoke.tool !== filter.tool) return false;
      if (filter.params !== undefined &&
          JSON.stringify(t.invoke.params ?? null) !== JSON.stringify(filter.params)) return false;
      return true;
    });
  }

  async add(spec: TriggerSpec): Promise<Trigger> {
    const now = new Date().toISOString();
    const doc: Trigger = {
      id:         crypto.randomUUID(),
      version:    crypto.randomUUID(),
      conditions: spec.conditions,
      invoke:     spec.invoke,
      ...(spec.enabled  !== undefined ? { enabled:  spec.enabled  } : {}),
      ...(spec.cooldown !== undefined ? { cooldown: spec.cooldown } : {}),
      createdAt:  now,
      updatedAt:  now,
    };
    await this.store.set(doc.id, doc);
    return doc;
  }

  async update(id: string, patch: Partial<TriggerSpec>): Promise<Trigger | undefined> {
    const cur = await this.store.get(id);
    if (cur === null) return undefined;
    return this.casMutate(cur, prev => ({
      ...prev,
      ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
      ...(patch.invoke     !== undefined ? { invoke:     patch.invoke     } : {}),
      ...(patch.enabled    !== undefined ? { enabled:    patch.enabled    } : {}),
      ...(patch.cooldown   !== undefined ? { cooldown:   patch.cooldown   } : {}),
      version:   crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async remove(id: string): Promise<boolean> {
    const cur = await this.store.get(id);
    if (cur === null) return false;
    await this.store.delete(id, cur.version);
    return true;
  }

  async importIfAbsent(spec: TriggerSpec): Promise<Trigger> {
    const key      = invokeKey(spec);
    const existing = (await this.all()).find(t => invokeKey(t) === key);
    if (existing !== undefined) return existing;
    return this.add(spec);
  }

  clear(): void { this.lifecycle.abort(); }

  /**
   * LLM-judge every enabled condition on `surface` against the current turn and return the distinct
   * triggers that fired, each with the set of `kinds` whose conditions matched (a trigger can carry
   * more than one kind on the same surface — `retract` and `followup` both read the agent response —
   * so the caller resolves the delivery) AND `matched` — the specific condition(s) that fired, with
   * the classifier's one-line reason for each. Without `matched`, a trigger with several conditions on
   * the same kind is indistinguishable in the trace from one with a single condition — "it fired" tells
   * you nothing about *why*, which is the question a false-positive post-mortem actually asks. Both
   * sides of the exchange are passed: `subject` is judged, `context` is what it is paired with — many
   * conditions are relational ("disputes the previous answer") and can only be judged from the pair.
   * `session` is the conversation, for the {@link TriggerFilter}: only the triggers it admits are judged.
   * No LLM call when there are no candidate conditions or the subject has neither text nor a summary.
   */
  async evaluate(
    session:      Session,
    surface:      TriggerSurface,
    subject:      ClassifiedMessage,
    context:      ClassifiedMessage,
    signal:       AbortSignal,
    turnProvider: string,
  ): Promise<{ trigger: Trigger; kinds: TriggerKind[]; matched: FiredCondition[] }[]> {
    if (subject.text === '' && subject.summary === undefined) return [];
    const offered = (await this.all())
      .filter(t => t.enabled !== false && t.conditions.some(c => surfaceOfKind(c.kind) === surface));
    if (offered.length === 0) return [];
    const triggers = await this.admitted(offered, { session, surface });

    // Candidate key is `${triggerId}#${conditionIndex}` — addressing conditions by index is fine
    // because evaluation is per-turn and the trigger set is stable for its duration. The surface a
    // condition belongs to is derived from its `kind` (ephemeral/contextual→user, retract/followup→agent).
    const candidates = triggers.flatMap(t => t.conditions
      .map((c, i) => ({ triggerId: t.id, key: `${t.id}#${i}`, index: i, kind: c.kind, rule: c.rule }))
      .filter(c => surfaceOfKind(c.kind) === surface));
    if (candidates.length === 0) return [];

    // The conditions are in the SYSTEM prompt and the exchange is the prompt. A prompt cache is a prefix
    // cache whichever provider keeps it, and every adapter sends the system prompt first, so the conditions
    // — nearly all of the input, and stable while the trigger set is — are a prefix any provider can reuse.
    // They used to follow the exchange, which changes every turn, so only the rubric ahead of it could be.
    const res = await this.services.singleTurn({
      provider: await this.resolveClassifierProvider(turnProvider),
      signal,
      system:
        'You are a trigger classifier for a conversational assistant. The current exchange — the user ' +
        'message and the assistant message, in chronological order and clearly labelled — is in the ' +
        `message you are sent; a list of conditions follows these instructions. Evaluate each condition ` +
        `against the "${subject.label}". The "${context.label}" is the message it is paired with; use it ` +
        'fully whenever a condition is relational (refers to what was asked, answered, disputed, or repeated).\n\n' +
        // Deliberately short. An earlier version enumerated precedence rules for MATCH vs DO NOT MATCH
        // clauses, written to adjudicate the long exclusion lists the stored conditions then carried.
        // That machinery had no business surviving the exclusions: it was itself a patch, and it was
        // what let a specific MATCH clause overrule a general exclusion and fire on a turn about the
        // mechanism it was meant to ignore. Conditions state their own scope now, so the judge needs
        // only the rubric and a bias to silence.
        // The doctrine the trigger_action tool already states to whoever WRITES a condition — "a rule is
        // a CONDITION on the FORM or SENTIMENT of a message, NOT its topic" — was missing here, where it
        // is the judge rather than the author who needs it. Its absence is what let a condition naming a
        // topic be satisfied by the topic's presence; a rule meant to describe the inside of a reply was
        // being matched against the outside of it.
        // Three bases, because the trigger set uses all three and one condition spans two: the Inner
        // Voice reads FORM and SENTIMENT, while remember_fact, the date condition and 'chez nous' read
        // CONTENT. A blanket "conditions never describe topic" was false of the latter — it happened to
        // test clean, but it was only true of the half of the set written most recently. Naming the
        // basis each condition declares is both accurate and the thing that CONTAINS semantic latitude:
        // a form condition gets none, and only a content condition gets paraphrase.
        'Every condition declares its own basis, and is judged on that basis alone:\n' +
        '• FORM — the shape of the message: a challenge, a complaint, a doubt, an assertion, a ' +
        'contradiction, a report. A form condition is never satisfied merely because the message is on ' +
        'the right topic, however exactly the subject appears to line up.\n' +
        '• SENTIMENT — the feeling or illocution it carries: frustration, disbelief, satisfaction, an ' +
        'apology, a promise, an admission.\n' +
        '• CONTENT — a fact, a name, a number, a date, or a stated phrase. A close paraphrase counts: a ' +
        'condition about relative time is met by "an hour ago" or "last week", not only by the words it ' +
        'happens to list. Latitude stops at paraphrase of what the condition actually names — it is not ' +
        'licence to match anything merely related to it.\n' +
        'Where a condition spans more than one basis, every requirement it states still applies.\n\n' +
        // The classifier sees text only; the rest of a turn reaches it as these summaries (turnSummary).
        'A bracketed line closing a message — "[Tool calls in this turn: …]", "[Files in this turn: …]" — ' +
        'is a summary of what that message\'s turn held besides its text, and is evidence like the text.\n\n' +
        'Match only on evidence actually present in the exchange. A condition that stays silent costs ' +
        'nothing; one that fires wrongly is disruptive and expensive.\n\n' +
        // Matches only. A verdict per condition cost output tokens in proportion to the trigger set — about
        // 6,500 for 125 conditions, two minutes of generation — so the verdict landed after the answer it
        // was meant to inform. Output is what takes the time; the matches alone are tens of tokens.
        // A list named for what it holds, not a map from id to evidence: in a map every value is a string,
        // so a model that listed a non-match anyway ("no evidence") would have fired it.
        `Judge only the "${subject.label}" — the other message is context for relational conditions, ` +
        'never itself a subject to judge. Return ONLY a JSON object listing the conditions that MATCH: ' +
        '{"matched": [{"id": "<the bracketed id>", "why": "<a terse fragment, at most ~15 words, citing the ' +
        'specific evidence — not a full sentence>"}]}. Leave out every condition that does not match; if ' +
        'none match, return {"matched": []}. No other text.\n\n' +
        `=== CONDITIONS (${candidates.length}) ===\n` +
        candidates.map(c => `--- [${c.key}] ---\n${c.rule}`).join('\n\n') +
        `\n\n=== END CONDITIONS ===`,
      prompt:
        `=== ${context.label.toUpperCase()} (earlier) ===\n${render(context)}\n\n` +
        `=== ${subject.label.toUpperCase()} (later — judge the conditions against THIS) ===\n${render(subject)}`,
    });

    const verdict = lastVerdict(res.text);
    if (verdict === undefined) {
      console.warn(`[triggers] ${surface} classifier returned no JSON verdict:`, JSON.stringify(res.text.slice(0, 400)));
      return [];
    }
    const matches = matchesOf(verdict);

    // Group fired conditions back to their triggers, keeping each matched condition's index/rule/why
    // alongside the distinct kinds that matched (kinds is a projection of matched, kept for callers
    // that only need delivery routing). Only candidates are looked up, so an id the classifier invents
    // — or one the filter withheld — fires nothing.
    const firedByTrigger = new Map<string, FiredCondition[]>();
    for (const c of candidates) {
      const v = matches.get(c.key);
      if (v === undefined) continue;
      const list = firedByTrigger.get(c.triggerId) ?? [];
      list.push({ index: c.index, kind: c.kind, rule: c.rule, ...v });
      firedByTrigger.set(c.triggerId, list);
    }
    const byId = new Map(triggers.map(t => [t.id, t]));
    return [...firedByTrigger].flatMap(([id, matched]) => {
      const trigger = byId.get(id);
      return trigger ? [{ trigger, kinds: [...new Set(matched.map(m => m.kind))], matched }] : [];
    });
  }

  // The triggers the registered TriggerFilter admits, as a subset of `offered` in offered order — see
  // TriggerFilter for why the answer is not taken as it stands, and why a throw admits everything.
  private async admitted(offered: Trigger[], ctx: TriggerFilterContext): Promise<Trigger[]> {
    const filter = this.services.TriggerFilter;
    if (filter === undefined) return offered;
    try {
      const ids = new Set((await filter.admit(offered, ctx)).map(t => t.id));
      return offered.filter(t => ids.has(t.id));
    } catch (e) {
      console.warn(`[triggers] the TriggerFilter threw, so every trigger is judged: ${e instanceof Error ? e.message : String(e)}`);
      return offered;
    }
  }

  private async casMutate(doc: Trigger, mutate: (cur: Trigger) => Trigger): Promise<Trigger> {
    let cur = doc;
    for (;;) {
      const next = mutate(cur);
      const r = await this.store.cas(cur.id, cur.version, next);
      if (r.ok) return next;
      const fresh = await this.store.get(cur.id);
      if (fresh === null) {
        await this.store.set(next.id, next);
        return next;
      }
      cur = fresh;
    }
  }
}
