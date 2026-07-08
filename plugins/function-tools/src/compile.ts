import { makeToolBox } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, ToolContext, ToolEvent, TypeScriptStripper } from '@matatbread/matbot-plugin-api';

export type CompiledFn = (tool: unknown, toolInContext: unknown, ...args: unknown[]) => Promise<unknown>;

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
  const wrapped = `(async function ${definition.replace(LEADING, '')})`;
  let stripped: string;
  try { stripped = await stripper.strip(wrapped); }
  catch (e) { throw new Error(`not valid TypeScript (${msg(e)})`); }
  const body = `return ${stripped}(${paramNames.join(', ')});`;
  try { return new AsyncFunction('tool', 'toolInContext', ...paramNames, body); }
  catch (e) { throw new Error(`could not compile (${msg(e)})`); }
}

/**
 * Run a compiled function, streaming its tool calls to stdout as they happen and yielding the return
 * value as the final `result`. The function is handed the {@link makeToolBox}-built `tool` proxy and its
 * `toolInContext` override factory: `tool.<name>(params)` resolves to that tool's structured result,
 * inheriting the calling turn's session/signal/prompt/provider; `toolInContext({ provider }).<name>(params)`
 * overrides a field for that call.
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

  let done = false;
  let errored = false;
  let result: unknown;
  let error: unknown;
  void fn(tool, toolInContext, ...argValues)
    .then(v => { result = v; }, e => { errored = true; error = e; })
    .finally(() => { done = true; const w = wake; wake = null; w?.(); });

  for (;;) {
    while (queue.length > 0) { const ev = queue.shift(); if (ev !== undefined) yield ev; }
    if (done) break;
    await new Promise<void>(r => { wake = r; });
  }
  if (errored) { yield { type: 'error', message: msg(error) }; return; }
  yield { type: 'result', value: result };
}
