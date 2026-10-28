import type { MatbotMachine, Session, PromptFn, MessageContent } from '@matatbread/matbot-plugin-api';
import { invokeTool } from '@matatbread/matbot-plugin-api';
import type { Trigger, TriggerInvoke, FiredCondition } from './types.js';

export interface DispatchOutcome {
  /** Whether the tool yielded a result — i.e. whether the model should be woken with it (inject). */
  hadResult: boolean;
  /** The yielded result (meaningful only when `hadResult`). */
  result:    unknown;
  /** The tool did not complete — absent, errored, threw, or was cut off — and an error marker says so. */
  failed:    boolean;
  /** Durable markers to persist: any the tool emitted, plus a synthesised error marker if it failed.
   *  These outlive the silent firing, so a post-mortem can see what each trigger actually did. */
  markers:   MessageContent[];
}

/** core's `TOOL_INPUT_INVALID`, the `code` on the error event a validator's rejection yields. Spelled
 *  here rather than imported because triggers depends on plugin-api alone; it is the one error a stored
 *  trigger can only recover from by being edited, which is why it is reported to the model. */
export const TOOL_INPUT_INVALID = 422;

/**
 * The input a trigger's tool is actually called with. An omitted `params` is `{}`, never `undefined`:
 * every tool input is an object (the model's own call of a parameterless tool sends `{}`), so passing
 * `undefined` made every such trigger fail validation — `remember_fact` and a `tool_function` with no
 * arguments among them — while reading as "no params needed" to whoever wrote it.
 */
export function invocationParams(invoke: TriggerInvoke): unknown {
  return invoke.params ?? {};
}

/**
 * Check an invocation against the tool's declared input BEFORE it is stored, with the same validators the
 * executor applies when the trigger fires (`tools.validate`) — so a trigger that could never run is
 * refused while its author is present to fix it, rather than failing silently on some later turn. Returns
 * the rejection as text, or `undefined` to accept. A tool that is not registered, or no validator, is
 * accepted: a trigger naming an absent tool fails soft by design, and nothing here can check what nothing
 * declares.
 */
export async function checkInvocation(services: MatbotMachine, invoke: TriggerInvoke): Promise<string | undefined> {
  if (services.tools.resolve(invoke.tool) === null) return undefined;
  const errs = await services.tools.validate?.(invoke.tool, invocationParams(invoke));
  if (errs === undefined || errs.length === 0) return undefined;
  return `params do not match tool "${invoke.tool}": ${errs.map(e => `${e.path}: ${e.message}`).join('; ')}`;
}

/**
 * Invoke a fired trigger's tool, observing its output. The observational rule decides whether the
 * model wakes: a tool that yields a `result` is producing model-facing content (`hadResult` → the
 * caller injects it); a tool that yields none is a silent side-effect (the model never wakes). Any
 * `marker` events the tool emits are collected for the caller to persist, and a tool that errors or
 * throws — or names an absent tool — is recorded as an error marker rather than vanishing into a log;
 * one cut off by an abort is recorded as interrupted, not as a failure. `matched` rides on that marker,
 * since a failed fire leaves no fire marker of its own to say why it fired.
 */
export async function dispatchTrigger(
  services: MatbotMachine,
  trigger:  Trigger,
  ctx:      { session: Session; signal: AbortSignal; provider: string; prompt?: PromptFn },
  matched?: FiredCondition[],
): Promise<DispatchOutcome> {
  const markers: MessageContent[] = [];
  let failed = false;
  // An aborted signal (a mid-turn steer, a user cancel) means the tool was cut off, not that it faulted:
  // the raw abort reason is an internal token ("steer") that reads as a real failure in a durable marker.
  // The runner reframes this for the tools it runs itself (INTERRUPTED_TOOL_RESULT); a trigger's tool runs
  // outside that loop, so the same reframing has to happen here. The trace is still recorded — a trigger
  // that was interrupted did nothing, and a post-mortem wants to know that — just not as an error.
  // `code` rides along so the next turn can tell a malformed invocation from an ordinary tool failure.
  const fail = (error: string, code?: number): void => {
    failed = true;
    const why  = matched !== undefined ? { matched } : {};
    const data = ctx.signal.aborted
      ? { triggerId: trigger.id, tool: trigger.invoke.tool, interrupted: true, ...why }
      : { triggerId: trigger.id, tool: trigger.invoke.tool, error, ...(code !== undefined ? { code } : {}), ...why };
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
      return { hadResult: false, result: undefined, failed, markers };
    }

    // The prompt (when the firing hook carries one — a live interactive session behind this turn) is
    // forwarded so a trigger can invoke an interactive tool (e.g. `ask_user`) for real; absent, the
    // tool runs non-interactively and a prompt attempt surfaces as a normal tool error.
    const events = invokeTool(services, trigger.invoke.tool, invocationParams(trigger.invoke), {
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
        fail(ev.message, ev.code);
      }
    }
  } catch (e) {
    if (!ctx.signal.aborted) console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" threw:`, e);
    fail(e instanceof Error ? e.message : String(e));
  }

  return { hadResult, result, failed, markers };
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
