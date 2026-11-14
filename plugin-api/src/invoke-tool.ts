import type { MatbotMachine, MatbotPlugin } from './plugin.js';
import type { Tool, ToolContext, ToolEvent, ToolResultFor, ToolProxy, PromptFn, FormField, PermissionContext, PermissionGate, PermissionRequest } from './types.js';
import { askPermissionGate } from './permission-gate.js';
import { callFrame, callFramesOf, withCallFrames } from './call-frames.js';

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
 * of a tool (the CLI's and the browser's `plugin-tool` both register `plugin`), and what
 * stops a plugin addressing a gate it does not own — tool-name collision on `register` is already
 * resolved, so the name is not something a second plugin can quietly claim.
 *
 * A request may name a `namespace` in place of the tool's name — for a tool whose name is chosen at RUN
 * TIME, which is a function-tools function — and it is honoured only if `tools` resolves it to a tool
 * stamped with the same plugin as this one. Both stamps are the host's (`register`, and the `screen` hook
 * that offered a turn tool), so a plugin can name only a gate it already owns. Without `tools`, or for a
 * tool known only by a bare name, there is nothing to check against, so a namespace is refused.
 *
 * `ask` is the RAW per-turn prompt, never a stand-in that answers with a field's default: `undefined`
 * is how "no human is reachable" reaches the policy, and a substitute would make that undecidable.
 * `gate` is the registered `PermissionGate`; it is a non-optional service, but a hand-assembled
 * machine (a test, a minimal embedder) may still have none, so the asking default stands in.
 *
 * `context` is where the call is made — its session, which a `session` answer is held against — and is
 * the binder's to state, never the tool's: the request a tool writes cannot carry it, so no tool can claim
 * another session's answers. Required, because a door that omitted it would silently never be offered a
 * session lifetime.
 */
export function bindGate(
  gate:    PermissionGate | undefined,
  tool:    string | Pick<Tool, 'name' | 'pluginName'>,
  ask:     PromptFn | undefined,
  context: PermissionContext,
  tools?:  { resolve(name: string): Pick<Tool, 'pluginName'> | null },
): Pick<ToolContext, 'gate' | 'gateSnapshot'> {
  const name  = typeof tool === 'string' ? tool : tool.name;
  const owner = typeof tool === 'string' ? undefined : tool.pluginName;
  const qualify = ({ namespace, ...req }: PermissionRequest & { namespace?: string }): PermissionRequest => {
    if (namespace !== undefined && namespace !== name
        && (owner === undefined || tools?.resolve(namespace)?.pluginName !== owner)) {
      throw new Error(`Tool "${name}" cannot ask permission under "${namespace}": a gate namespace must be a tool registered by the same plugin.`);
    }
    return { ...req, gate: `${namespace ?? name}.${req.gate}` };
  };
  return {
    gate: async req => {
      const qualified = qualify(req);
      const decision = await (gate ?? askPermissionGate).decide(qualified, ask, context);
      if (!decision.allowed && decision.source === 'fallback') reportUnattended(name, qualified.gate, qualified.subject);
      return decision;
    },
    // Not reported when unattended: a synchronous caller cannot ask even with a human present, so a
    // fallback here says nothing about whether anybody was there.
    gateSnapshot: async () => {
      const snapshot = await (gate ?? askPermissionGate).snapshot(context);
      return req => snapshot(qualify(req));
    },
  };
}

// When nobody can be asked (a background job, a trigger, `POST /tools/:name`), a gate refuses, and the model
// is told so. Nobody else would be: the operation simply did not happen, in a process nobody is watching. So
// it is logged, naming what a standing answer would have to say to allow it. At error level, because a
// background job's process keeps only errors (its output is its result); and at most once an hour per gate
// and subject, because a dashboard polling a gated tool would otherwise log every poll.
const UNATTENDED_REPORT_MS = 60 * 60 * 1000;
const unattendedReported = new Map<string, number>();
function reportUnattended(tool: string, gate: string, subject: string): void {
  const key = `${gate}\0${subject}`;
  const now = Date.now();
  if (now - (unattendedReported.get(key) ?? -Infinity) < UNATTENDED_REPORT_MS) return;
  unattendedReported.set(key, now);
  console.error(`[gate] Refused ${gate} for "${subject}" (tool ${tool}): nobody was there to ask. ` +
                `To allow it unattended, give a standing answer for that gate and subject (e.g. answer "Always" ` +
                `when it is next asked in the UI, or configure the permission policy).`);
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
  & Partial<Pick<ToolContext, 'prompt' | 'provider' | 'callId' | 'turnTools' | 'appender'>>;

/**
 * Programmatically invoke a tool by name, the same way the harness does — resolve it off the
 * machine's tool registry (else the turn's own tools, when `opts` carries them), build a `ToolContext` from the machine, and return its event stream.
 * The host-only bits a one-shot caller can't derive (the session under which the call runs, its
 * abort signal, and an optional interactive `prompt`/`provider`) come in via `opts` — pass the
 * calling tool's `ctx` to forward them all (see {@link InvokeToolOptions}); everything else (vault,
 * plugin (un)loading, workdir/files) is filled from `machine`.
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
  // The registry first, as the runner does: a turn tool never shadows a registered one.
  const tool = machine.tools.resolve(name) ?? opts.turnTools?.get(name) ?? null;
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
    ...bindGate(machine.PermissionGate, tool, opts.prompt, { session: opts.session.id }, machine.tools),
    ...(opts.provider      !== undefined ? { provider:   opts.provider      } : {}),
    ...(opts.turnTools     !== undefined ? { turnTools:  opts.turnTools     } : {}),
    ...(opts.appender      !== undefined ? { appender:   opts.appender      } : {}),
    ...(machine.workdir    !== undefined ? { workdir:    machine.workdir    } : {}),
    ...(machine.files      !== undefined ? { files:      machine.files      } : {}),
  };

  // The registry is name-keyed and untyped (`ToolExecutor.execute` yields `ToolEvent<unknown>`); the
  // `ToolContracts` mapping is the call-site contract, asserted here so callers read a typed result.
  return tool.executor.execute(params, ctx) as AsyncIterable<ToolEvent<ToolResultFor<K, P>>>;
}

/**
 * The one drain: consume a tool event stream, keeping the last `result` and throwing on the first
 * `error`. Whether a stream that yielded NO result is a failure is the caller's question, and the only
 * thing the three public drains ever disagreed on — so it is the only thing they pass in. A `marker` goes
 * to `onMarker` when there is one: it is the callee's durable record, which a drain that keeps only the
 * value would lose while the callee reported success (a session `define` made from a body was simply gone).
 */
async function drain<R>(events: AsyncIterable<ToolEvent<R>>, onMarker?: (ev: ToolEvent<R>) => void): Promise<{ value: R | undefined; hadResult: boolean }> {
  let value: R | undefined;
  let hadResult = false;
  for await (const ev of events) {
    if      (ev.type === 'result') { value = ev.value; hadResult = true; }
    else if (ev.type === 'error')  { throw new Error(ev.message); }
    else if (ev.type === 'marker') { onMarker?.(ev); }
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
async function drainProxyResult<R>(events: AsyncIterable<ToolEvent<R>>, onMarker?: (ev: ToolEvent) => void): Promise<R | undefined> {
  return (await drain(events, onMarker)).value;
}

/**
 * A factory for a context-overridden {@link ToolProxy}: `toolInContext({ provider }).some_tool(params)`
 * runs `some_tool` under another provider, everything else inherited. Keyed on `ToolContracts`, so a
 * hallucinated tool name is a **compile error**.
 *
 * Two fields, an ALLOW-list, because the caller is often model-authored code and every field of the call
 * context is something a callee trusts:
 *   - `provider` — which configured profile serves the call. The user configured each one, and adding one
 *     is gated, so choosing among them reaches nothing new.
 *   - `signal` — combined with the call's own, so it can cancel the callee SOONER (a deadline for one
 *     call) and never later. Replacing it outright would let a call outlive the turn the user stopped.
 * Not `prompt`: it is the channel a callee's gates ask through, so supplying one answered them. Not
 * `appender`: it says where this run's reports go, so a caller could read them or send them elsewhere. Not
 * `session`: some standing answers are per session (`tool_function.edit`'s "in this session"), so naming
 * another borrowed what the user granted there. Not `turnTools`: they resolve beside the registry, so a
 * caller could hand over an executor of its own and have the host give it a `ToolContext`. An allow-list
 * rather than leaving those four out, so that a field added to `InvokeToolOptions` later is not
 * overridable until someone decides it should be.
 */
export type ToolBox = (call?: Pick<InvokeToolOptions, 'provider'> & { signal?: AbortSignal }) => ToolProxy;

/**
 * Build the typed calling surface both `function-tools` compositions and compiled skills use:
 *
 *   const { tool, toolInContext } = makeToolBox(machine, callContext, { onEvent });
 *   await tool.some_tool(params);                     // bound context; a bad name is a compile error
 *   await toolInContext({ provider }).some_tool(...); // override one field for this call
 *
 * `tool` is a {@link ToolProxy} bound to `callContext`; `toolInContext({ provider })` returns a fresh proxy
 * under that provider (never mutating `tool`). `onEvent`, when supplied, receives a `stdout`
 * trace per call (→ name / ← result) so a run is observable, and every `marker` a callee yields, which
 * its owner must pass on for the callee's record to be kept; omit it for a silent surface. `hostCall` is
 * a `FunctionRunner`'s, for a box whose caller is a body that runner runs: each call's params are
 * copied and the call made through it. Built on {@link invokeTool}/{@link toolResult}, which remain the
 * low-level, dynamic-name seam.
 *
 * A call's promise is marked handled as it is made, so a rejection the caller never looks at is not an
 * unhandled rejection: the caller is often model-authored code, and `void tool.x()` there must not end
 * the process. The caller still sees the rejection wherever it awaits.
 */
export function makeToolBox(
  machine:     MatbotMachine,
  defaultCall: InvokeToolOptions,
  opts?:       { onEvent?: (event: ToolEvent) => void; hostCall?: <T>(fn: () => T) => T },
): { tool: ToolProxy; toolInContext: ToolBox } {
  const host = opts?.hostCall;
  const build = (call: InvokeToolOptions): ToolProxy =>
    new Proxy({}, {
      get(_target, prop) {
        // A symbol key, or `then`, must not read as a callable tool — otherwise the proxy looks like a
        // thenable and awaiting/returning it would try to invoke a tool named `then`.
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return (params?: unknown): Promise<unknown> => {
          const made = callOne(prop, params, call);
          made.catch(() => { /* handled: see the doc comment */ });
          return made;
        };
      },
    }) as ToolProxy;
  const callOne = async (prop: string, params: unknown, call: InvokeToolOptions): Promise<unknown> => {
    opts?.onEvent?.({ type: 'stdout', chunk: `→ ${prop}(${compactTrace(params)})\n` });
    // A callee's markers go to `onEvent`, so a box whose owner yields what it receives (function-tools)
    // passes them up to the runner, which stores them as it would the callee's own: the callee was told
    // its record was kept. A box with no `onEvent` has nowhere to put them. Each goes up stamped with this
    // call's frame ahead of any its own callees added, so the runner can store the whole chain (CallFrame).
    const onEvent = opts?.onEvent;
    const callee = machine.tools.resolve(prop) ?? call.turnTools?.get(prop);
    const onMarker = onEvent === undefined ? undefined : (ev: ToolEvent): void => {
      if (ev.type !== 'marker') { onEvent(ev); return; }
      onEvent(withCallFrames(ev, [callFrame(prop, callee), ...(callFramesOf(ev) ?? [])]));
    };
    const run = (p: unknown): Promise<unknown> => drainProxyResult(invokeTool(machine, prop, p, call), onMarker);
    let value: unknown;
    if (host === undefined) value = await run(params ?? {});
    else {
      // Copied here, in the caller's code, so a getter or `toJSON` among the params runs as the
      // caller's and nothing of the caller's is left to run past `hostCall` (FunctionRunner.hostCall).
      const copy: unknown = structuredClone(params ?? {});
      value = await host(() => run(copy));
    }
    opts?.onEvent?.({ type: 'stdout', chunk: `← ${prop}: ${compactTrace(value)}\n` });
    return value;
  };
  // Each field read off the override by name, once, never spread: whatever else the object carries stays
  // with the caller (see ToolBox for why each field is or is not here).
  const toolInContext: ToolBox = (override) => {
    const provider = override?.provider;
    const signal   = override?.signal;
    return build({
      ...defaultCall,
      ...(provider !== undefined ? { provider } : {}),
      // `any` aborts when EITHER does, so the override can only add a reason to stop.
      ...(signal !== undefined ? { signal: AbortSignal.any([defaultCall.signal, signal]) } : {}),
    });
  };
  return { tool: build(defaultCall), toolInContext };
}
