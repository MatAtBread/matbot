import type { MatbotMachine } from './plugin.js';
import type { ToolContext, ToolEvent, ToolResultFor, ToolProxy, PromptFn, FormField } from './types.js';

/**
 * Inputs to {@link invokeTool} that a one-shot caller can't derive from the machine. A tool
 * forwarding a call to another tool should pass its own {@link ToolContext} straight through as
 * `opts` — `session`, `signal`, `prompt` and crucially **`provider`** all propagate, so a callee
 * that needs an LLM (e.g. `find_fact`, or anything using `singleTurn`) inherits the same model
 * rather than finding no provider. Only spell out individual fields when starting a call from
 * scratch or deliberately overriding one; never hand-pick a subset of `ctx` and drop the rest.
 */
export type InvokeToolOptions =
  Pick<ToolContext, 'session' | 'signal'>
  & Partial<Pick<ToolContext, 'prompt' | 'provider' | 'callId'>>;

/**
 * Programmatically invoke a tool by name, the same way the harness does — resolve it off the
 * machine's tool registry, build a `ToolContext` from the machine, and return its event stream.
 * The host-only bits a one-shot caller can't derive (the session under which the call runs, its
 * abort signal, and an optional interactive `prompt`/`provider`) come in via `opts` — pass the
 * calling tool's `ctx` to forward them all (see {@link InvokeToolOptions}); everything else (vault,
 * plugin (un)loading, workdir/configPath/files) is filled from `machine`.
 *
 * Throws synchronously if no tool is registered under `name`. When no `prompt` is supplied the tool
 * runs non-interactively: any attempt to prompt rejects, which a tool surfaces as a normal error
 * event. Pair with {@link toolText} to collapse the stream to its result string.
 */
export function invokeTool<K extends string, const P>(
  machine: MatbotMachine,
  name:    K,
  params:  P,
  opts:    InvokeToolOptions,
): AsyncIterable<ToolEvent<ToolResultFor<K, P>>> {
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

  // The registry is name-keyed and untyped (`ToolExecutor.execute` yields `ToolEvent<unknown>`); the
  // `ToolContracts` mapping is the call-site contract, asserted here so callers read a typed result.
  return tool.executor.execute(params, ctx) as AsyncIterable<ToolEvent<ToolResultFor<K, P>>>;
}

/**
 * Drain a tool event stream (e.g. {@link invokeTool}'s return) to its raw `result` *value*, typed:
 * paired with `invokeTool(machine, name, …)` it returns whatever `ToolContracts[name]` declares (or
 * `unknown` for an unregistered tool). This is the structured counterpart to {@link toolText} — use it
 * for any tool that returns data; use `toolText` when you want the result collapsed to a string.
 * Stops and throws on the first `error` event, or if the tool finished without yielding a `result`.
 */
export async function toolResult<R>(events: AsyncIterable<ToolEvent<R>>): Promise<R> {
  let value!: R;
  let hadResult = false;
  for await (const ev of events) {
    if      (ev.type === 'result') { value = ev.value; hadResult = true; }
    else if (ev.type === 'error')  { throw new Error(ev.message); }
  }
  if (!hadResult) throw new Error('Tool produced no result');
  return value;
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

/** Compact a value to one trace line. */
function compactTrace(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

/**
 * A factory for a context-overridden {@link ToolProxy}: `toolInContext({ provider }).some_tool(params)`
 * runs `some_tool` with the given fields merged over the box's bound context (omitted fields inherited).
 * Keyed on `ToolContracts`, so a hallucinated tool name is a **compile error**. This is the explicit
 * escape hatch beside the default `tool` proxy — reach for it only when a call needs a different provider,
 * signal, prompt or session.
 */
export type ToolBox = (call?: Partial<InvokeToolOptions>) => ToolProxy;

/**
 * Build the typed calling surface both `function-tools` compositions and compiled skills use:
 *
 *   const { tool, toolInContext } = makeToolBox(machine, callContext, { onEvent });
 *   await tool.some_tool(params);                     // bound context; a bad name is a compile error
 *   await toolInContext({ provider }).some_tool(...); // override one field for this call
 *
 * `tool` is a {@link ToolProxy} bound to `callContext`; `toolInContext(override)` returns a fresh proxy
 * with `override` merged over it (never mutating `tool`). `onEvent`, when supplied, receives a `stdout`
 * trace per call (→ name / ← result) so a run is observable; omit it for a silent surface. Built on
 * {@link invokeTool}/{@link toolResult}, which remain the low-level, dynamic-name seam.
 */
export function makeToolBox(
  machine:     MatbotMachine,
  defaultCall: InvokeToolOptions,
  opts?:       { onEvent?: (event: ToolEvent) => void },
): { tool: ToolProxy; toolInContext: ToolBox } {
  const build = (call: InvokeToolOptions): ToolProxy =>
    new Proxy({}, {
      get(_target, prop) {
        // A symbol key, or `then`, must not read as a callable tool — otherwise the proxy looks like a
        // thenable and awaiting/returning it would try to invoke a tool named `then`.
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return async (params?: unknown): Promise<unknown> => {
          opts?.onEvent?.({ type: 'stdout', chunk: `→ ${prop}(${compactTrace(params)})\n` });
          const value = await toolResult(invokeTool(machine, prop, params ?? {}, call));
          opts?.onEvent?.({ type: 'stdout', chunk: `← ${prop}: ${compactTrace(value)}\n` });
          return value;
        };
      },
    }) as ToolProxy;
  const toolInContext: ToolBox = (override) => build(override === undefined ? defaultCall : { ...defaultCall, ...override });
  return { tool: build(defaultCall), toolInContext };
}
