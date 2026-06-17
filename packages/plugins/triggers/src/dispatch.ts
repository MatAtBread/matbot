import type { MatbotServices, Session, ToolContext, PromptFn, FormField } from '@matatbread/matbot-plugin-api';
import type { Trigger } from './types.js';

// Dispatch runs out-of-band (inside a hook, no live user), so there is no one to prompt: a tool that
// tries resolves to a rejection it can surface as a normal tool error.
const rejectingPrompt: PromptFn = (((p: string | FormField): Promise<string> => {
  const label = typeof p === 'string' ? p : p.label;
  return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${label}"`));
}) as PromptFn);

/**
 * Invoke a fired trigger's tool and return what the model should see, or `undefined` when there is
 * nothing to inject. This is the observational rule: the tool's OUTPUT decides whether the model
 * wakes. A tool that yields a `result` is producing model-facing content → return it (inject). A
 * tool that yields no result (a pure side-effect — its only trace a marker it persists itself) →
 * return `undefined` (direct; the model never wakes). An absent tool degrades soft: skip + warn.
 *
 * (For now every wired trigger loads a skill, which always yields a result, so the inject path is
 * the only one exercised. The direct path falls out for free the day a marker-only tool is wired.)
 */
export async function dispatchTrigger(
  services: MatbotServices,
  trigger:  Trigger,
  ctx:      { session: Session; signal: AbortSignal; provider: string },
): Promise<unknown | undefined> {
  const tool = services.tools.resolve(trigger.invoke.tool);
  if (tool === null) {
    console.warn(`[triggers] trigger ${trigger.id} invokes unknown tool "${trigger.invoke.tool}"; skipped.`);
    return undefined;
  }

  const toolCtx: ToolContext = {
    callId:       crypto.randomUUID(),
    session:      ctx.session,
    signal:       ctx.signal,
    vault:        services.vault,
    provider:     ctx.provider,
    prompt:       rejectingPrompt,
    loadPlugin:   (specifier: string) => services.loadPlugin(specifier),
    unloadPlugin: (specifier: string) => services.unloadPlugin(specifier),
    ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
    ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    ...(services.files      !== undefined ? { files:      services.files      } : {}),
  };

  let result: unknown;
  let hadResult = false;
  try {
    for await (const ev of tool.executor.execute(trigger.invoke.params, toolCtx)) {
      if (ev.type === 'result') { result = ev.value; hadResult = true; }
      else if (ev.type === 'error') {
        console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" errored: ${ev.message}`);
        return undefined;
      }
    }
  } catch (e) {
    console.warn(`[triggers] trigger ${trigger.id} tool "${trigger.invoke.tool}" threw:`, e);
    return undefined;
  }

  return hadResult ? result : undefined;
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
