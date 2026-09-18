import type { MatbotMachine, MatbotPlugin } from './plugin.js';
import type { ToolContext, ToolEvent, ToolResultFor, ToolProxy, PromptFn, FormField, PermissionGate } from './types.js';
import { askPermissionGate } from './permission-gate.js';

/** The host's plugin hot-load ops, as both the runner and {@link invokeTool} hold them. */
export interface PluginOps {
  loadPlugin(specifier: string, prompt?: PromptFn, refresh?: boolean): Promise<MatbotPlugin>;
  unloadPlugin(specifier: string): Promise<boolean>;
}

/**
 * Bind the plugin hot-load ops for a {@link ToolContext}, closing over the turn's `prompt`.
 *
 * That closure is the whole point of `ToolContext.loadPlugin` existing alongside
 * `MatbotRuntime.loadPlugin`: a tool cannot forget to pass the prompt, so an interactive load cannot
 * silently become non-interactive at one call site out of six — the same reasoning that makes the
 * principal ambient rather than threaded. What it should not be is written out twice, once in the runner
 * and once here, since the injected middle argument is exactly the shape a signature change breaks
 * quietly.
 */
export function bindPluginOps(host: PluginOps, prompt: PromptFn): Pick<ToolContext, 'loadPlugin' | 'unloadPlugin'> {
  return {
    loadPlugin:   (specifier, refresh) => host.loadPlugin(specifier, prompt, refresh),
    unloadPlugin: (specifier)          => host.unloadPlugin(specifier),
  };
}

/**
 * Bind {@link ToolContext.gate} for a tool call, qualifying the suffix the tool supplies with the name
 * it is registered under: `ctx.gate({ gate: 'add', … })` from the `plugin` tool asks `plugin.add`.
 * Qualifying by TOOL name rather than package is what makes one policy cover both runtimes' versions
 * of a tool (node's `tool-plugin` and the browser's `plugin-tool` both register `plugin`), and what
 * stops a plugin addressing a gate it does not own — tool-name collision on `register` is already
 * resolved, so the name is not something a second plugin can quietly claim.
 *
 * `ask` is the RAW per-turn prompt, never a stand-in that answers with a field's default: `undefined`
 * is how "no human is reachable" reaches the policy, and a substitute would make that undecidable.
 * `gate` is the registered `PermissionGate`; it is a non-optional service, but a hand-assembled
 * machine (a test, a minimal embedder) may still have none, so the asking default stands in.
 */
export function bindGate(
  gate:     PermissionGate | undefined,
  toolName: string,
  ask:      PromptFn | undefined,
): Pick<ToolContext, 'gate'> {
  return {
    gate: req => (gate ?? askPermissionGate).decide({ ...req, gate: `${toolName}.${req.gate}` }, ask),
  };
}

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
 * Throws synchronously if no tool is registered under `name`, or if `opts.signal` has already aborted.
 * When no `prompt` is supplied the tool
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
  // A call whose turn was cancelled never starts. Otherwise a composed body looping over `await tool.x()`
  // goes on calling tools after the abort, each callee deciding for itself whether to honour the signal.
  if (opts.signal.aborted) throw new Error(`Tool "${name}" was not started: the call was cancelled.`);

  const prompt = opts.prompt ?? rejectingPrompt;
  const ctx: ToolContext = {
    callId:       opts.callId ?? crypto.randomUUID(),
    session:      opts.session,
    signal:       opts.signal,
    vault:        machine.Vault,
    prompt,
    ...bindPluginOps(machine, prompt),
    // The raw `opts.prompt`, not the rejecting stand-in above: a gate must be able to tell "nobody is
    // here" from "a human answered", and `POST /tools/:name` reaching a privileged tool is exactly the
    // non-interactive case the request's `fallback` exists to answer.
    ...bindGate(machine.PermissionGate, name, opts.prompt),
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
 * The one drain: consume a tool event stream, keeping the last `result` and throwing on the first
 * `error`. Whether a stream that yielded NO result is a failure is the caller's question, and the only
 * thing the three public drains ever disagreed on — so it is the only thing they pass in.
 */
async function drain<R>(events: AsyncIterable<ToolEvent<R>>): Promise<{ value: R | undefined; hadResult: boolean }> {
  let value: R | undefined;
  let hadResult = false;
  for await (const ev of events) {
    if      (ev.type === 'result') { value = ev.value; hadResult = true; }
    else if (ev.type === 'error')  { throw new Error(ev.message); }
  }
  return { value, hadResult };
}

/**
 * Drain a tool event stream (e.g. {@link invokeTool}'s return) to its raw `result` *value*, typed:
 * paired with `invokeTool(machine, name, …)` it returns whatever `ToolContracts[name]` declares (or
 * `unknown` for an unregistered tool). This is the structured counterpart to {@link toolText} — use it
 * for any tool that returns data; use `toolText` when you want the result collapsed to a string.
 * Stops and throws on the first `error` event, or if the tool finished without yielding a `result`.
 */
export async function toolResult<R>(events: AsyncIterable<ToolEvent<R>>): Promise<R> {
  const { value, hadResult } = await drain(events);
  if (!hadResult) throw new Error('Tool produced no result');
  return value as R;
}

/**
 * Drain a tool event stream (e.g. {@link invokeTool}'s return) to its result as text. Stops and
 * throws on the first `error` event, or if the tool finished without yielding a `result`. The result
 * value is rendered the way the model would see it: a string verbatim, a `{ content: string }`
 * (the shape `skill_action` and other prose tools return) by its `content`, anything else as JSON.
 */
export async function toolText(events: AsyncIterable<ToolEvent>): Promise<string> {
  const result = await toolResult(events);

  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object' && typeof (result as { content?: unknown }).content === 'string') {
    return (result as { content: string }).content;
  }
  return JSON.stringify(result, null, 2);
}

const cannotPrompt = (p: string | FormField): Promise<string> =>
  Promise.reject(new Error(`Non-interactive context: cannot prompt for "${typeof p === 'string' ? p : p.label}"`));

/**
 * The stand-in for "there is nobody to ask": every request rejects, naming the field, which a tool's
 * surrounding try/catch turns into an ordinary error event.
 *
 * Deliberately NOT what a gate is handed — see {@link bindGate}. A gate must be able to tell "nobody is
 * here" (`ask === undefined`) from "a human answered", and a stand-in that answers makes that
 * undecidable.
 */
export const rejectingPrompt: PromptFn = cannotPrompt as PromptFn;

/**
 * The stand-in that answers with a field's OWN default where it has one, and rejects like
 * {@link rejectingPrompt} where it does not — what `ToolContext.prompt` is when the host supplied no
 * channel. The two stand-ins shared one message written out twice, in two packages; what actually
 * separates them is this one line, so it is the only thing that differs now.
 */
export const defaultingPrompt: PromptFn = (((p: string | FormField, def?: string): Promise<string> => {
  const fallback = typeof p === 'string' ? def : p.default;
  return fallback !== undefined ? Promise.resolve(fallback) : cannotPrompt(p);
}) as PromptFn);

/** Compact a value to one trace line. */
function compactTrace(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

/**
 * The {@link ToolProxy}'s drain. Unlike {@link toolResult}, a stream that ends with no `result` resolves
 * to `undefined` instead of throwing — a tool whose work is a side effect yields nothing BY DESIGN
 * (`function-tools` omits the event when a body returns nothing, and the triggers dispatcher fires only
 * on a yielded result), and this proxy is the surface such a tool is called through. Throwing here made
 * the one surface meant to be silent the one that shouted.
 *
 * A tool that declares a DATA result and yields nothing is still an error — but it is caught where the
 * types are, not re-derived from a contract string on every call: the checker compiles a body against its
 * declared return type, and `strict` rejects one that can fall through (TS2355 with no return at all,
 * TS2366 when only some paths do). A body declaring `T | undefined` is deliberately NOT rejected —
 * `undefined` IS its contract, and is exactly what this drain hands back. Two paths reach here unchecked
 * and resolve to `undefined` rather than throwing: an explicit `noTypeCheck`, and the browser, where there
 * is no `ToolTypeIndex`. Both are opted into.
 */
async function drainProxyResult<R>(events: AsyncIterable<ToolEvent<R>>): Promise<R | undefined> {
  return (await drain(events)).value;
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
          const value = await drainProxyResult(invokeTool(machine, prop, params ?? {}, call));
          opts?.onEvent?.({ type: 'stdout', chunk: `← ${prop}: ${compactTrace(value)}\n` });
          return value;
        };
      },
    }) as ToolProxy;
  const toolInContext: ToolBox = (override) => build(override === undefined ? defaultCall : { ...defaultCall, ...override });
  return { tool: build(defaultCall), toolInContext };
}
