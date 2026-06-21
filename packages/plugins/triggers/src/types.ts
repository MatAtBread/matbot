/**
 * A trigger is a data-driven hook: a set of natural-language conditions and the single tool call to
 * make when any of them is judged to match. The conditions are the OR — many ways to recognise the
 * situation — and `invoke` is the one consequence. There is no skill coupling: a trigger names a
 * tool, not a skill, so firing a skill is just `invoke: skill_action({ action: 'use', … })` like
 * any other tool call (`use` applies the skill as a directive; `load` returns raw content, which is
 * for reading/editing, not firing). What the model sees afterwards is decided observationally — see dispatch.ts.
 */

/**
 * What a trigger does when one of its conditions matches. A single discriminator: it fixes the
 * surface judged, the hook, AND how the fired tool's output reaches the model — because those are
 * not independent (delivery determines surface). The three are disjoint and exhaustive:
 *
 *  `augment`  — judge the USER message (pre-response `screen` hook); run the tool and inject its
 *    output ephemerally into the turn about to run. The classic "route knowledge in" case.
 *  `retract`  — judge the ASSISTANT response (post-commit `followup` hook); the response is treated
 *    as WRONG — pop it into a retraction marker and re-run the user turn with the output injected, so
 *    the bad answer does NOT remain (e.g. "the field is `pgdwell`, not `dwell`": everything built on
 *    the wrong field is void, so regenerate from scratch with the correction).
 *  `followup` — judge the ASSISTANT response (post-commit `followup` hook); the response STANDS but
 *    warrants a steer or verification — keep it and resubmit the output as a robo turn, so the
 *    response stays in context for the steer to make sense (Inner Voice / Verify Assumptions /
 *    Bicameral — critiques *of* the standing answer, meaningless without it).
 *
 * The author picks the kind because only they know whether a match means "read this first" /
 * "this is wrong" / "look again".
 */
export type TriggerKind = 'augment' | 'retract' | 'followup';

/** The conversational surface a `kind` is judged against, and which hook does the judging: `augment`
 *  reads the user message (pre-response `screen` hook); `retract`/`followup` read the assistant
 *  response (post-commit `followup` hook). Derived from `kind` — see {@link surfaceOfKind}. */
export type TriggerSurface = 'user' | 'agent';

export function surfaceOfKind(kind: TriggerKind): TriggerSurface {
  return kind === 'augment' ? 'user' : 'agent';
}

/** A trigger condition: a `kind` (what a match does, and the surface it's judged on) plus a `rule`. */
export interface TriggerCondition {
  kind: TriggerKind;
  /** A single LLM-judged rubric, e.g. "MATCH if …; DO NOT MATCH if …", judged against the turn. */
  rule: string;
}

/** One condition the classifier judged matched, for tracing *why* a trigger fired (not just that it
 *  did): `index` addresses it within the owning trigger's `conditions` array, `rule` is the rubric
 *  text at the time of evaluation, and `why` is the classifier's one-line justification (absent if it
 *  didn't supply one). */
export interface FiredCondition {
  index: number;
  kind:  TriggerKind;
  rule:  string;
  why?:  string;
}

/** The tool call a matched trigger makes. `params` is passed verbatim as the tool's input. */
export interface TriggerInvoke {
  tool:    string;
  params?: unknown;
}

export interface Trigger {
  id:         string;
  version:    string;
  conditions: TriggerCondition[];
  invoke:     TriggerInvoke;
  /** Absent ⇒ enabled. A disabled trigger is kept but never evaluated. */
  enabled?:   boolean;
  createdAt:  string;
  updatedAt:  string;
}

/** Fields a caller supplies when creating or replacing a trigger; identity/versioning is the store's. */
export interface TriggerSpec {
  conditions: TriggerCondition[];
  invoke:     TriggerInvoke;
  enabled?:   boolean;
}

/**
 * The registry interface other plugins consume (`services.Triggers`) to create triggers without
 * knowing who owns the store or the hooks. CRUD only — evaluation and dispatch are internal to the
 * triggers plugin, which owns the hooks that drive them.
 */
export interface Triggers {
  all(): Trigger[];
  get(id: string): Trigger | undefined;
  /** Triggers whose invocation matches the filter — `tool` (if given) equals `invoke.tool`, `params`
   *  (if given) deep-equals `invoke.params`. The "which trigger(s) fire tool X" lookup. */
  query(filter: { tool?: string; params?: unknown }): Trigger[];
  add(spec: TriggerSpec): Promise<Trigger>;
  update(id: string, patch: Partial<TriggerSpec>): Promise<Trigger | undefined>;
  remove(id: string): Promise<boolean>;
  /** Seed idempotently: no-op (returns the existing trigger) when one with the same `invoke`
   *  (tool + params) is already stored. Identity is the invocation, since triggers carry no name. */
  importIfAbsent(spec: TriggerSpec): Promise<Trigger>;
}
