import { RegistryChangeKind } from '@matatbread/matbot-plugin-api';
import type { Tool, ToolRegistry, Notifier, ToolContext, ToolEvent, ToolInputError } from './types.js';

/** Judges one call: every `validate` hook. */
export type ToolCallJudge = (tool: string, parameters: unknown, signal: AbortSignal) => Promise<ToolInputError[] | undefined>;

/** Cap on the rendered value. Long enough to identify what was sent, short enough that a base64
 *  attachment or a large document cannot turn one rejected field into the bulk of a turn's context. */
const VALUE_CHARS = 160;

/**
 * `.x: expected string, actual value \`{"x":8}\``
 *
 * The value is wrapped in its own field name, so what is shown is a fragment the caller can compare
 * against what it sent rather than a bare literal it has to locate. An array element or the root has no
 * name to wrap it in, so those render the value alone — the path already says which one it was.
 */
function formatError(e: ToolInputError): string {
  if (e.value === undefined) return `${e.path}: ${e.message}`;
  const named = /\.([A-Za-z_$][\w$]*)$/.exec(e.path);
  let shown: string;
  try {
    // Validation now runs on internal calls too, so this is not always JSON.parse output: a caller can
    // reach here with a bigint or a cycle, and a throw while REPORTING an error would replace the
    // diagnosis with a stack trace.
    shown = JSON.stringify(named ? { [named[1]!]: e.value } : e.value) ?? String(e.value);
  } catch {
    return `${e.path}: ${e.message}`;
  }
  if (shown.length > VALUE_CHARS) shown = `${shown.slice(0, VALUE_CHARS)}…`;
  return `${e.path}: ${e.message}, actual value \`${shown}\``;
}

/**
 * The `code` on the `error` event a rejected call yields. 422 rather than 400 because the body parsed
 * fine and its *shape* is wrong, and — the reason a number is safe here at all — a process exit code
 * cannot exceed 255, so this can never be mistaken for one (`bash` puts its exit status in the same
 * field). A transport may map a 4xx code onto its own status; nothing is obliged to.
 */
export const TOOL_INPUT_INVALID = 422;

/**
 * Validation belongs at the executor, not in a `toolcall` hook, because that hook is a RUNNER channel:
 * it guards the model's path and nothing else. `POST /tools/:name` and `invokeTool` both call
 * `tool.executor.execute` directly and fire no runner hooks, so a runner hook leaves two doors open and
 * invites the per-door duplication that then drifts. Wrapping here is the one place every door already
 * passes through — which is why the `validate` hook channel is dispatched from here, not by the runner.
 *
 * Wrapped at REGISTRATION rather than at `resolve`, so there is exactly one wrapper per tool and
 * `resolve(x) === resolve(x)` still holds.
 *
 * Validators are consulted per CALL, not captured: they are registered long after the tools are, and
 * may be unloaded. None with an opinion ⇒ the call passes straight through, so core mandates no
 * validation — it only honours what is registered. The cost when a validator IS
 * present is one generator frame plus a structural check (measured in the tens of nanoseconds against
 * tool work measured in milliseconds); the deliberate trade is that an INTERNAL call is validated too,
 * though a statically-typed call site should already be sound. That is not pure waste: `invokeTool`
 * with a dynamic name, a trigger's `invoke.params` (typed `object`) and a compiled skill's payload are
 * all internal callers whose input no compiler has checked.
 */
function validatingTool(tool: Tool, judge: ToolCallJudge): Tool {
  const inner = tool.executor;
  return {
    ...tool,
    executor: {
      execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        return (async function* () {
          const errs = await judge(tool.name, input, ctx.signal);
          if (errs !== undefined && errs.length > 0) {
            const detail = errs.map(formatError).join('; ');
            yield { type: 'error', message: `Invalid input for tool "${tool.name}": ${detail}`, code: TOOL_INPUT_INVALID };
            return;
          }
          // `yield*` delegates `return`/`throw` as well as values, so an abort still reaches the tool.
          yield* inner.execute(input, ctx);
        })();
      },
    },
  };
}

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  // The host's notifier proxy, injected at boot (both hosts build it before this registry). Held as the
  // proxy, not a resolved impl, so a later register('Notifier', …) takes effect here too. Optional: a
  // registry built without one (tests) simply announces nothing.
  private readonly notifier: Notifier | undefined;
  // Host-injected, and consulted per call: validators are registered by plugins long after the builtin
  // tools are seeded, and may be unloaded again.
  private readonly judge: ToolCallJudge | undefined;

  constructor(initial?: Iterable<Tool>, notifier?: Notifier, judge?: ToolCallJudge) {
    this.judge = judge;
    if (initial !== undefined) for (const tool of initial) this.tools.set(tool.name, this.guard(tool));
    this.notifier = notifier;
  }

  private guard(tool: Tool): Tool {
    return this.judge === undefined ? tool : validatingTool(tool, this.judge);
  }

  async validate(name: string, parameters: unknown): Promise<ToolInputError[] | undefined> {
    return this.judge?.(name, parameters, new AbortController().signal);
  }

  private announce(name: string, operation: 'added' | 'removed', pluginName?: string): void {
    this.notifier?.notify({
      kind: RegistryChangeKind, source: 'tools', registry: 'tools', name, operation,
      ...(pluginName !== undefined ? { detail: { pluginName } } : {}),
    });
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, this.guard(tool));
    this.announce(tool.name, 'added', tool.pluginName);
  }

  remove(name: string): void {
    if (this.tools.delete(name)) this.announce(name, 'removed');
  }

  removeByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName && this.tools.delete(name)) this.announce(name, 'removed');
    }
  }

  resolve(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
