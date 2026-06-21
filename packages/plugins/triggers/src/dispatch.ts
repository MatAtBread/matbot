import type { MatbotMachine, Session, ToolContext, PromptFn, FormField, MessageContent } from '@matatbread/matbot-plugin-api';
import type { Trigger } from './types.js';

// Fallback when the firing hook carries no interactive prompt (cron/background run, or a frontend
// that supplied none): a tool that tries to prompt resolves to a rejection it surfaces as a normal
// tool error. When the hook DOES carry a prompt (a live interactive session behind this turn), it is
// forwarded instead, so a trigger can invoke an interactive tool (e.g. `ask_user`) for real.
const rejectingPrompt: PromptFn = (((p: string | FormField): Promise<string> => {
  const label = typeof p === 'string' ? p : p.label;
  return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${label}"`));
}) as PromptFn);

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
 * throws — or names an absent tool — is recorded as an error marker rather than vanishing into a log.
 */
export async function dispatchTrigger(
  services: MatbotMachine,
  trigger:  Trigger,
  ctx:      { session: Session; signal: AbortSignal; provider: string; prompt?: PromptFn },
): Promise<DispatchOutcome> {
  const markers: MessageContent[] = [];
  const fail = (error: string): void => {
    markers.push({ type: 'marker', creator: 'triggers', data: { triggerId: trigger.id, tool: trigger.invoke.tool, error } });
  };

  let result: unknown;
  let hadResult = false;
  // Total by construction: every path through here either returns an outcome or records a `fail`
  // marker — nothing escapes. A trigger's tool can throw, hang-then-abort, or emit an error event,
  // and the worst case is "this trigger did nothing and left a trace"; sibling triggers, the hook,
  // and the session are unaffected. (The hook dispatcher's own try/catch is a second layer behind this.)
  try {
    const tool = services.tools.resolve(trigger.invoke.tool);
    if (tool === null) {
      console.warn(`[triggers] trigger ${trigger.id} invokes unknown tool "${trigger.invoke.tool}"; skipped.`);
      fail(`tool "${trigger.invoke.tool}" not registered`);
      return { hadResult: false, result: undefined, markers };
    }

    const toolCtx: ToolContext = {
      callId:       crypto.randomUUID(),
      session:      ctx.session,
      signal:       ctx.signal,
      vault:        services.Vault,
      provider:     ctx.provider,
      prompt:       ctx.prompt ?? rejectingPrompt,
      // Forward the prompt into plugin loading too (mirrors the normal loop): collision resolution
      // during a loaded plugin's setup() prompts the user, so a trigger that loads a plugin (e.g. the
      // DRTX case — an agent reply triggers `plugin(load …)`) is interactive end-to-end, not just at
      // the tool's own ctx.prompt calls.
      loadPlugin:   (specifier: string) => services.loadPlugin(specifier, ctx.prompt ?? rejectingPrompt),
      unloadPlugin: (specifier: string) => services.unloadPlugin(specifier),
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
    };

    for await (const ev of tool.executor.execute(trigger.invoke.params, toolCtx)) {
      if      (ev.type === 'result') { result = ev.value; hadResult = true; }
      else if (ev.type === 'marker') { markers.push({ type: 'marker', creator: ev.creator, data: ev.data }); }
      else if (ev.type === 'error')  {
        console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" errored: ${ev.message}`);
        fail(ev.message);
      }
    }
  } catch (e) {
    console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" threw:`, e);
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
