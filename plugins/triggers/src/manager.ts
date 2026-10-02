import type { Store, MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { Trigger, TriggerSpec, TriggerSurface, TriggerKind, Triggers, FiredCondition } from './types.js';
import { surfaceOfKind } from './types.js';

const MAX_MSG_CHARS = 4000;

// Back-compat default: installs that configured a provider literally named "skills-classifier" (the
// former hard-coded classifier name) keep working with no migration. A `classifierProvider` setting
// overrides it; absent both, the classifier falls back to the turn's own provider.
const LEGACY_CLASSIFIER = 'skills-classifier';

function clip(text: string): string {
  if (text.length <= MAX_MSG_CHARS) return text;
  const half = Math.floor((MAX_MSG_CHARS - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
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
  // the next turn): the `classifierProvider` setting if set and valid, else the legacy "skills-classifier"
  // provider if present, else the current turn's own provider. There is always a turn provider to fall
  // back to, so the classifier always has a model — triggers work with zero config.
  async resolveClassifierProvider(turnProvider: string): Promise<string> {
    const pinned = await this.services.settings().get<string>('classifierProvider');
    if (pinned !== undefined && this.services.providers.has(pinned)) return pinned;
    if (this.services.providers.has(LEGACY_CLASSIFIER)) return LEGACY_CLASSIFIER;
    return turnProvider;
  }

  /** Read straight through the backing store on every call — no in-memory snapshot. The store is a
   *  swap-following proxy, so this always reflects the live backend AND the current principal's
   *  partition, and a shared backend's out-of-band writes are seen too. A snapshot here would be
   *  principal-blind and go stale under any second writer; caching, if a slow backend needs it,
   *  belongs in the StorageBackend, not in this consumer. */
  async all(): Promise<Trigger[]> {
    const { items } = await this.store.query({});
    return items;
  }

  async get(id: string): Promise<Trigger | undefined> {
    return (await this.store.get(id)) ?? undefined;
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
   * conditions are relational ("disputes the previous answer") and can only be judged from the pair. No
   * LLM call when there are no candidate conditions or the subject is empty.
   */
  async evaluate(
    surface:      TriggerSurface,
    subject:      { label: string; text: string },
    context:      { label: string; text: string },
    signal:       AbortSignal,
    turnProvider: string,
  ): Promise<{ trigger: Trigger; kinds: TriggerKind[]; matched: FiredCondition[] }[]> {
    // Candidate key is `${triggerId}#${conditionIndex}` — addressing conditions by index is fine
    // because evaluation is per-turn and the trigger set is stable for its duration. The surface a
    // condition belongs to is derived from its `kind` (ephemeral/contextual→user, retract/followup→agent).
    const triggers   = await this.all();
    const candidates = triggers
      .filter(t => t.enabled !== false)
      .flatMap(t => t.conditions
        .map((c, i) => ({ triggerId: t.id, key: `${t.id}#${i}`, index: i, kind: c.kind, rule: c.rule }))
        .filter(c => surfaceOfKind(c.kind) === surface));
    if (candidates.length === 0 || subject.text === '') return [];

    const res = await this.services.singleTurn({
      provider: await this.resolveClassifierProvider(turnProvider),
      signal,
      system:
        'You are a trigger classifier for a conversational assistant. Below is the current exchange — ' +
        'the user message and the assistant message, in chronological order and clearly labelled — ' +
        `followed by a list of conditions. Evaluate each condition against the "${subject.label}". The ` +
        `"${context.label}" is the message it is paired with; use it fully whenever a condition is ` +
        'relational (refers to what was asked, answered, disputed, or repeated).\n\n' +
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
        'Match only on evidence actually present in the text above. A condition that stays silent costs ' +
        'nothing; one that fires wrongly is disruptive and expensive.\n\n' +
        `Judge only the "${subject.label}" — the other message is context for relational conditions, ` +
        'never itself a subject to judge. Return ONLY a JSON object mapping each condition id (the ' +
        'bracketed value) to an object {"match": true|false, "why": "<a terse fragment, at most ~15 words, ' +
        'citing the specific evidence — not a full sentence>"}. No other text.',
      prompt:
        `=== ${context.label.toUpperCase()} (earlier) ===\n${context.text === '' ? '(none)' : clip(context.text)}\n\n` +
        `=== ${subject.label.toUpperCase()} (later — judge the conditions against THIS) ===\n${clip(subject.text)}\n\n` +
        `=== CONDITIONS (${candidates.length}) ===\n` +
        candidates.map(c => `--- [${c.key}] ---\n${c.rule}`).join('\n\n') +
        `\n\n=== END CONDITIONS ===`,
    });

    let verdicts: Record<string, unknown> = {};
    try {
      const m = res.text.match(/\{[\s\S]*\}/);
      verdicts = m ? JSON.parse(m[0]) : {};
    } catch {
      console.warn(`[triggers] ${surface} classifier returned non-JSON:`, res.text.slice(0, 200));
      return [];
    }

    // Group fired conditions back to their triggers, keeping each matched condition's index/rule/why
    // alongside the distinct kinds that matched (kinds is a projection of matched, kept for callers
    // that only need delivery routing).
    const firedByTrigger = new Map<string, FiredCondition[]>();
    for (const c of candidates) {
      const v = verdicts[c.key] as { match?: unknown; why?: unknown } | boolean | undefined;
      const isMatch = typeof v === 'object' && v !== null ? v.match === true : v === true;
      if (!isMatch) continue;
      const why = typeof v === 'object' && v !== null && typeof v.why === 'string' ? v.why : undefined;
      const list = firedByTrigger.get(c.triggerId) ?? [];
      list.push({ index: c.index, kind: c.kind, rule: c.rule, ...(why !== undefined ? { why } : {}) });
      firedByTrigger.set(c.triggerId, list);
    }
    const byId = new Map(triggers.map(t => [t.id, t]));
    return [...firedByTrigger].flatMap(([id, matched]) => {
      const trigger = byId.get(id);
      return trigger ? [{ trigger, kinds: [...new Set(matched.map(m => m.kind))], matched }] : [];
    });
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
