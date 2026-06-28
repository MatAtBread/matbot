import type { MatbotMachine } from './plugin.js';
import type { ToolContext, ToolEvent, PromptFn, FormField, Session } from './types.js';

/**
 * Programmatically invoke a tool by name, the same way the harness does — resolve it off the
 * machine's tool registry, build a `ToolContext` from the machine, and return its event stream.
 * The host-only bits a one-shot caller can't derive (the session under which the call runs, its
 * abort signal, and an optional interactive `prompt`/`provider`) come in via `opts`; everything
 * else (vault, plugin (un)loading, workdir/configPath/files) is filled from `machine`.
 *
 * Throws synchronously if no tool is registered under `name`. When no `prompt` is supplied the tool
 * runs non-interactively: any attempt to prompt rejects, which a tool surfaces as a normal error
 * event. Pair with {@link toolText} to collapse the stream to its result string.
 */
export function invokeTool(
  machine: MatbotMachine,
  name:    string,
  params:  unknown,
  opts:    { session: Session; signal: AbortSignal; prompt?: PromptFn; provider?: string; callId?: string },
): AsyncIterable<ToolEvent> {
  const tool = machine.tools.resolve(name);
  if (tool === null) throw new Error(`Tool "${name}" is not registered`);

  const prompt = opts.prompt ?? rejectingPrompt;
  const ctx: ToolContext = {
    callId:       opts.callId ?? crypto.randomUUID(),
    session:      opts.session,
    signal:       opts.signal,
    vault:        machine.Vault,
    prompt,
    loadPlugin:   (specifier, refresh) => machine.loadPlugin(specifier, prompt, refresh),
    unloadPlugin: (specifier) => machine.unloadPlugin(specifier),
    ...(opts.provider      !== undefined ? { provider:   opts.provider      } : {}),
    ...(machine.workdir    !== undefined ? { workdir:    machine.workdir    } : {}),
    ...(machine.configPath !== undefined ? { configPath: machine.configPath } : {}),
    ...(machine.files      !== undefined ? { files:      machine.files      } : {}),
  };

  return tool.executor.execute(params, ctx);
}

/**
 * Drain a tool event stream (e.g. {@link invokeTool}'s return) to its result as text. Stops and
 * throws on the first `error` event, or if the tool finished without yielding a `result`. The result
 * value is rendered the way the model would see it: a string verbatim, a `{ content: string }`
 * (the shape `skill_action` and other prose tools return) by its `content`, anything else as JSON.
 */
export async function toolText(events: AsyncIterable<ToolEvent>): Promise<string> {
  let result: unknown;
  let hadResult = false;
  for await (const ev of events) {
    if      (ev.type === 'result') { result = ev.value; hadResult = true; }
    else if (ev.type === 'error')  { throw new Error(ev.message); }
  }
  if (!hadResult) throw new Error('Tool produced no result');

  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object' && typeof (result as { content?: unknown }).content === 'string') {
    return (result as { content: string }).content;
  }
  return JSON.stringify(result, null, 2);
}

const rejectingPrompt: PromptFn = (((p: string | FormField): Promise<string> => {
  const label = typeof p === 'string' ? p : p.label;
  return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${label}"`));
}) as PromptFn);
