import type { Store, MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { Trigger, TriggerSpec, TriggerSurface, TriggerKind, Triggers, FiredCondition } from './types.js';
import { surfaceOfKind } from './types.js';

const MAX_MSG_CHARS = 1500;

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
  private readonly triggers = new Map<string, Trigger>();
  private readonly store:    Store<Trigger>;
  private readonly services: MatbotMachine;

  constructor(store: Store<Trigger>, services: MatbotMachine) {
    this.store    = store;
    this.services = services;
  }

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

  async init(): Promise<void> {
    const { items } = await this.store.query({});
    for (const t of items) {
      this.triggers.set(t.id, t);
    }
  }

  all(): Trigger[] { return [...this.triggers.values()]; }
  get(id: string): Trigger | undefined { return this.triggers.get(id); }

  /** Triggers whose invocation matches the filter: `tool` (if given) must equal `invoke.tool`, and
   *  `params` (if given) must deep-equal `invoke.params`. The natural "which trigger(s) fire tool X
   *  (with these args)" lookup — e.g. the one that loads a given skill. */
  query(filter: { tool?: string; params?: unknown }): Trigger[] {
    return this.all().filter(t => {
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
      version:    Date.now().toString(),
      conditions: spec.conditions,
      invoke:     spec.invoke,
      ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
      createdAt:  now,
      updatedAt:  now,
    };
    await this.store.set(doc.id, doc);
    this.triggers.set(doc.id, doc);
    return doc;
  }

  async update(id: string, patch: Partial<TriggerSpec>): Promise<Trigger | undefined> {
    const cur = this.triggers.get(id);
    if (cur === undefined) return undefined;
    return this.casMutate(cur, prev => ({
      ...prev,
      ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
      ...(patch.invoke     !== undefined ? { invoke:     patch.invoke     } : {}),
      ...(patch.enabled    !== undefined ? { enabled:    patch.enabled    } : {}),
      version:   Date.now().toString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async remove(id: string): Promise<boolean> {
    const cur = this.triggers.get(id);
    if (cur === undefined) return false;
    await this.store.delete(id, cur.version);
    this.triggers.delete(id);
    return true;
  }

  async importIfAbsent(spec: TriggerSpec): Promise<Trigger> {
    const key      = invokeKey(spec);
    const existing = this.all().find(t => invokeKey(t) === key);
    if (existing !== undefined) return existing;
    return this.add(spec);
  }

  clear(): void { this.triggers.clear(); }

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
    const candidates = this.all()
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
        'relational (refers to what was asked, answered, disputed, or repeated). Fire a condition when, ' +
        `reading the "${subject.label}" in light of the "${context.label}", it holds. Return ONLY a JSON ` +
        'object mapping each condition id (the bracketed value) to an object {"match": true|false, ' +
        '"why": "<one short sentence citing the specific evidence>"}. No other text.',
      prompt:
        `${context.label} (earlier):\n${context.text === '' ? '(none)' : clip(context.text)}\n\n` +
        `${subject.label} (later — evaluate the conditions against THIS):\n${clip(subject.text)}\n\n` +
        `Conditions:\n${candidates.map(c => `[${c.key}] ${c.rule}`).join('\n')}`,
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
    return [...firedByTrigger].flatMap(([id, matched]) => {
      const trigger = this.triggers.get(id);
      return trigger ? [{ trigger, kinds: [...new Set(matched.map(m => m.kind))], matched }] : [];
    });
  }

  private async casMutate(doc: Trigger, mutate: (cur: Trigger) => Trigger): Promise<Trigger> {
    let cur = doc;
    for (;;) {
      const next = mutate(cur);
      const r = await this.store.cas(cur.id, cur.version, next);
      if (r.ok) { this.triggers.set(next.id, next); return next; }
      const fresh = await this.store.get(cur.id);
      if (fresh === null) {
        await this.store.set(next.id, next);
        this.triggers.set(next.id, next);
        return next;
      }
      cur = fresh;
    }
  }
}
