import { makeToolBox } from '@matatbread/matbot-plugin-api';
import { stripLeadingTrivia } from './signature.js';
import type { MatbotMachine, ComposedCallContext, ToolContext, ToolEvent, TypeScriptStripper } from '@matatbread/matbot-plugin-api';

export type CompiledFn = (tool: unknown, toolInContext: unknown, context: ComposedCallContext, ...args: unknown[]) => Promise<unknown>;

/** The identifiers injected ahead of a function's own parameters — reserved, hence unusable as param names. */
export const INJECTED = ['tool', 'toolInContext', 'context'] as const;

const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as
  new (...names: string[]) => CompiledFn;

const LEADING = /^\s*(?:async\s+)?(?:function\s+)?/;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Compile a method-shorthand function definition into a runnable async function. The body is wrapped
 * as an immediately-returned function expression — `(async function <rest>)(...args)` — so both the
 * named (define) and anonymous (lambda) forms strip and construct through one path. Everything runs
 * async so tool calls inside can be awaited; `tool` is the proxy passed as the first argument. Type
 * erasure is delegated to the host-provided {@link TypeScriptStripper} (node's native stripper or the
 * browser's sucrase), so this stays platform-agnostic; because that strip may be async, so is this.
 */
export async function buildAsyncFn(stripper: TypeScriptStripper, definition: string, paramNames: string[]): Promise<CompiledFn> {
  // Leading trivia goes first: a doc comment ahead of the definition would otherwise land between
  // `function` and the name, which is a syntax error rather than the harmless prose it looks like.
  const wrapped = `(async function ${stripLeadingTrivia(definition).replace(LEADING, '')})`;
  let stripped: string;
  try { stripped = await stripper.strip(wrapped); }
  catch (e) { throw new Error(`not valid TypeScript (${msg(e)})`); }
  const body = `return ${stripped}(${paramNames.join(', ')});`;
  try { return new AsyncFunction(...INJECTED, ...paramNames, body); }
  catch (e) { throw new Error(`could not compile (${msg(e)})`); }
}

/**
 * Run a compiled function, streaming its tool calls to stdout as they happen and yielding the return
 * value as the final `result`. That same queue is what `context.progress()` writes to, which is why a
 * body that cannot `yield` can still report mid-run. The function is handed the {@link makeToolBox}-built `tool` proxy and its
 * `toolInContext` override factory: `tool.<name>(params)` resolves to that tool's structured result,
 * inheriting the calling turn's session/signal/prompt/provider; `toolInContext({ provider }).<name>(params)`
 * overrides a field for that call. Those two carry the context *downwards* but expose none of it to the
 * body, so the call's own identity rides alongside as `context` ({@link ComposedCallContext}) — read-only, and
 * rebuilt per invocation (a `define`d function is compiled once and runs under many sessions).
 */
export async function* runFunction(
  machine:   MatbotMachine,
  ctx:       ToolContext,
  fn:        CompiledFn,
  argValues: unknown[],
): AsyncIterable<ToolEvent> {
  const queue: ToolEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (ev: ToolEvent): void => { queue.push(ev); const w = wake; wake = null; w?.(); };

  const { tool, toolInContext } = makeToolBox(machine, {
    session: ctx.session,
    signal:  ctx.signal,
    prompt:  ctx.prompt,
    ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
  }, { onEvent: emit });

  const context: ComposedCallContext = {
    callId:    ctx.callId,
    sessionId: ctx.session.id,
    signal:    ctx.signal,
    // Normalised here rather than in each renderer: this is the boundary where a model-authored body
    // hands over a number, and `i / n * 100` is the obvious way to compute one. The CLI prints it raw.
    progress:  (pct, message) => emit({
      type: 'progress',
      pct:  Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
      ...(message !== undefined && message !== '' ? { message } : {}),
    }),
    ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
    ...(ctx.workdir  !== undefined ? { workdir:  ctx.workdir  } : {}),
  };

  let done = false;
  let errored = false;
  let result: unknown;
  let error: unknown;
  void fn(tool, toolInContext, context, ...argValues)
    .then(v => { result = v; }, e => { errored = true; error = e; })
    .finally(() => { done = true; const w = wake; wake = null; w?.(); });

  for (;;) {
    while (queue.length > 0) { const ev = queue.shift(); if (ev !== undefined) yield ev; }
    if (done) break;
    await new Promise<void>(r => { wake = r; });
  }
  if (errored) { yield { type: 'error', message: msg(error) }; return; }
  // `undefined` is "no result", not "a result that is undefined": a composition that returns nothing
  // yields no `result` event, exactly like a hand-written tool whose work is a side-effect. This is the
  // difference between a silent verdict and a noisy one — the triggers dispatcher fires only on a
  // yielded result, so a composition used as a trigger's `invoke` could not stay silent while it always
  // yielded. Downstream already expects result-less tools (the Anthropic converter names one).
  if (result !== undefined) yield { type: 'result', value: result };
}
