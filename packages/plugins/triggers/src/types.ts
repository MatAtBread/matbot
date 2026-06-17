/**
 * A trigger is a data-driven hook: a set of natural-language conditions and the single tool call to
 * make when any of them is judged to match. The conditions are the OR — many ways to recognise the
 * situation — and `invoke` is the one consequence. There is no skill coupling: a trigger names a
 * tool, not a skill, so loading a skill is just `invoke: skill_action({ action: 'load', … })` like
 * any other tool call. What the model sees afterwards is decided observationally — see dispatch.ts.
 */

/** Which conversational surface a condition is judged against, and in which hook it is evaluated.
 *  `user` — the incoming user message, in the pre-response `screen` hook (injected ephemerally).
 *  `agent` — the assistant's committed response, in the post-commit `followup` hook (resubmitted). */
export type TriggerPhase = 'agent' | 'user';

export interface TriggerCondition {
  phase: TriggerPhase;
  /** A single LLM-judged rubric, e.g. "MATCH if …; DO NOT MATCH if …", judged against the turn. */
  rule:  string;
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
  add(spec: TriggerSpec): Promise<Trigger>;
  update(id: string, patch: Partial<TriggerSpec>): Promise<Trigger | undefined>;
  remove(id: string): Promise<boolean>;
  /** Seed idempotently: no-op (returns the existing trigger) when one with the same `invoke`
   *  (tool + params) is already stored. Identity is the invocation, since triggers carry no name. */
  importIfAbsent(spec: TriggerSpec): Promise<Trigger>;
}
