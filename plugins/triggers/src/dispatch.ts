import type { MatbotMachine, Session, PromptFn, MessageContent } from '@matatbread/matbot-plugin-api';
import { invokeTool } from '@matatbread/matbot-plugin-api';
import type { Trigger } from './types.js';

export interface DispatchOutcome {
  /** Whether the tool yielded a result — i.e. whether the model should be woken with it (inject). */
  hadResult: boolean;
  /** The yielded result (meaningful only when `hadResult`). */
  result:    unknown;
  /** Durable markers to persist: any the tool emitted, plus a synthesised error marker if it failed.
   *  These outlive the silent firing, so a post-mortem can see what each trigger actually did. */
  markers:   MessageContent[];
}

/**
 * Invoke a fired trigger's tool, observing its output. The observational rule decides whether the
 * model wakes: a tool that yields a `result` is producing model-facing content (`hadResult` → the
 * caller injects it); a tool that yields none is a silent side-effect (the model never wakes). Any
 * `marker` events the tool emits are collected for the caller to persist, and a tool that errors or
 * throws — or names an absent tool — is recorded as an error marker rather than vanishing into a log;
 * one cut off by an abort is recorded as interrupted, not as a failure.
 */
export async function dispatchTrigger(
  services: MatbotMachine,
  trigger:  Trigger,
  ctx:      { session: Session; signal: AbortSignal; provider: string; prompt?: PromptFn },
): Promise<DispatchOutcome> {
  const markers: MessageContent[] = [];
  // An aborted signal (a mid-turn steer, a user cancel) means the tool was cut off, not that it faulted:
  // the raw abort reason is an internal token ("steer") that reads as a real failure in a durable marker.
  // The runner reframes this for the tools it runs itself (INTERRUPTED_TOOL_RESULT); a trigger's tool runs
  // outside that loop, so the same reframing has to happen here. The trace is still recorded — a trigger
  // that was interrupted did nothing, and a post-mortem wants to know that — just not as an error.
  const fail = (error: string): void => {
    const data = ctx.signal.aborted
      ? { triggerId: trigger.id, tool: trigger.invoke.tool, interrupted: true }
      : { triggerId: trigger.id, tool: trigger.invoke.tool, error };
    markers.push({ type: 'marker', creator: 'triggers', data });
  };

  let result: unknown;
  let hadResult = false;
  // Total by construction: every path through here either returns an outcome or records a `fail`
  // marker — nothing escapes. A trigger's tool can throw, hang-then-abort, or emit an error event,
  // and the worst case is "this trigger did nothing and left a trace"; sibling triggers, the hook,
  // and the session are unaffected. (The hook dispatcher's own try/catch is a second layer behind this.)
  try {
    if (services.tools.resolve(trigger.invoke.tool) === null) {
      console.warn(`[triggers] trigger ${trigger.id} invokes unknown tool "${trigger.invoke.tool}"; skipped.`);
      fail(`tool "${trigger.invoke.tool}" not registered`);
      return { hadResult: false, result: undefined, markers };
    }

    // The prompt (when the firing hook carries one — a live interactive session behind this turn) is
    // forwarded so a trigger can invoke an interactive tool (e.g. `ask_user`) for real; absent, the
    // tool runs non-interactively and a prompt attempt surfaces as a normal tool error.
    const events = invokeTool(services, trigger.invoke.tool, trigger.invoke.params, {
      session:  ctx.session,
      signal:   ctx.signal,
      provider: ctx.provider,
      ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}),
    });

    for await (const ev of events) {
      if      (ev.type === 'result') { result = ev.value; hadResult = true; }
      else if (ev.type === 'marker') { markers.push({ type: 'marker', creator: ev.creator, data: ev.data }); }
      else if (ev.type === 'error')  {
        if (!ctx.signal.aborted) console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" errored: ${ev.message}`);
        fail(ev.message);
      }
    }
  } catch (e) {
    if (!ctx.signal.aborted) console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" threw:`, e);
    fail(e instanceof Error ? e.message : String(e));
  }

  return { hadResult, result, markers };
}

/**
 * Render a tool result into the text injected for the model. A string is used verbatim; an object
 * with a string `content` field (the shape `skill_action(load)` and other prose-producing tools
 * return) uses that; anything else is shown as JSON. (Rendering fidelity for arbitrary tools is a
 * known rough edge — see the slice notes.)
 */
export function renderResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string') {
    return (value as { content: string }).content;
  }
  return JSON.stringify(value, null, 2);
}
