import { RegistryChangeKind } from '@matatbread/matbot-plugin-api';
import type { Tool, ToolRegistry, Notifier, ToolContext, ToolEvent } from './types.js';

/**
 * Structural contract for a registered input validator — duck-typed, never imported, exactly as
 * `ProfileDirectory` is: core must not depend on whichever plugin implements it (today
 * `@matatbread/matbot-tool-types`, from a tool's `ToolContract` params type), and the shape is the
 * whole agreement. `undefined` means NO OPINION — no contract for this tool, or one that cannot be
 * honestly validated — and is never read as "valid".
 */
export interface ToolInputValidator {
  validateToolCall(tool: string, parameters: unknown): Promise<ToolInputError[] | undefined>;
}

/**
 * One rejected field. `path` is dotted, as a caller would WRITE the access (`.items[0].name`) rather
 * than as JSON Pointer — the reader is either a model repairing its own call or a developer looking at
 * a 422, and both write dots. `.` alone is the whole value.
 *
 * `value` is what was actually supplied there, and is what makes the difference between a message a
 * model can act on and one it has to guess at. Optional because a validator may not have it, and
 * `undefined` specifically means ABSENT: JSON carries no undefined, so there is nothing to show for a
 * missing property beyond saying it is missing.
 */
export interface ToolInputError {
  path:   string;
  message: string;
  value?: unknown;
}

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
 * Declared HERE, by the consumer, rather than by any of the plugins that implement it — `json-validation`
 * (against `inputSchema`) and `ts-validation` (against the `ToolContract` type) both register this key,
 * and two plugins declaring one key must declare it identically or the merge is a TS2717 in a file
 * neither owns. Core reads it, so core names it.
 *
 * Exactly one is active, since the registry holds one value per key. A validator that loads over another
 * should capture the one it displaces and delegate to it when it has no opinion of its own — which is
 * how the typed and schema validators compose rather than shadow each other.
 */
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    ToolCallValidator?: ToolInputValidator;
  }
}

/**
 * The `code` on the `error` event a rejected call yields. 422 rather than 400 because the body parsed
 * fine and its *shape* is wrong, and — the reason a number is safe here at all — a process exit code
 * cannot exceed 255, so this can never be mistaken for one (`bash` puts its exit status in the same
 * field). A transport may map a 4xx code onto its own status; nothing is obliged to.
 */
export const TOOL_INPUT_INVALID = 422;

/**
 * Validation belongs at the executor, not in a `toolcall` hook, because the hook is a RUNNER channel:
 * it guards the model's path and nothing else. `POST /tools/:name` and `invokeTool` both call
 * `tool.executor.execute` directly and fire no hooks, so a hook leaves two doors open and invites the
 * per-door duplication that then drifts. Wrapping here is the one place every door already passes
 * through.
 *
 * Wrapped at REGISTRATION rather than at `resolve`, so there is exactly one wrapper per tool and
 * `resolve(x) === resolve(x)` still holds.
 *
 * The validator is looked up per CALL, not captured: it may be registered long after the tools are
 * (plugin order), and it may be unloaded. No validator ⇒ the call passes straight through, so core
 * mandates no validation — it only honours one that is registered. The cost when a validator IS
 * present is one generator frame plus a structural check (measured in the tens of nanoseconds against
 * tool work measured in milliseconds); the deliberate trade is that an INTERNAL call is validated too,
 * though a statically-typed call site should already be sound. That is not pure waste: `invokeTool`
 * with a dynamic name, a trigger's `invoke.params` (typed `object`) and a compiled skill's payload are
 * all internal callers whose input no compiler has checked.
 */
function validatingTool(tool: Tool, lookup: () => ToolInputValidator | undefined): Tool {
  const inner = tool.executor;
  return {
    ...tool,
    executor: {
      execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        return (async function* () {
          const errs = await lookup()?.validateToolCall(tool.name, input);
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
  // Host-injected, late-bound: a validator is typically registered by a plugin long after the builtin
  // tools are seeded, so this is read per call rather than resolved here.
  private readonly validator: (() => ToolInputValidator | undefined) | undefined;

  constructor(initial?: Iterable<Tool>, notifier?: Notifier, validator?: () => ToolInputValidator | undefined) {
    this.validator = validator;
    if (initial !== undefined) for (const tool of initial) this.tools.set(tool.name, this.guard(tool));
    this.notifier = notifier;
  }

  private guard(tool: Tool): Tool {
    return this.validator === undefined ? tool : validatingTool(tool, this.validator);
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
