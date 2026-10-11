import vm from 'node:vm';
import { FUNCTION_TIMEOUT, type FunctionRunner } from '@matatbread/matbot-core';

// The default, when `function_timeout_ms` is absent from matbot.yaml. Far past any legitimate stretch of
// computation between two awaits, and short enough that the daemon is back before anyone concludes it died.
export const FUNCTION_SYNC_LIMIT_MS = 10_000;

const PENDING = 'matbot.functionRunner.pending';

/**
 * Globals bound to `undefined` for a body. Two kinds, and the distinction is worth keeping straight:
 * `process`, `globalThis`, `global` and `Buffer` genuinely EXIST here and are being withheld; `require`,
 * `module`, `exports`, `__dirname` and `__filename` never existed in a bare function expression at all,
 * and are listed so that node's types — which the check gate loads to type `import('node:…')` — cannot
 * make one of them typecheck and then fail at the first call. `eval` and `Function` go for the obvious
 * reason, knowing that `.constructor` reaches the latter anyway.
 *
 * `console`, `fetch` and the timers are deliberately absent from this list: a body legitimately logs,
 * waits and makes requests, and `fetch` means network access is NOT what this withholds.
 */
const SHADOWED = [
  'process', 'globalThis', 'global', 'Buffer', 'require', 'module', 'exports',
  '__dirname', '__filename', 'eval', 'Function',
] as const;

// A vm timeout bounds only code started by a vm script, so each call runs through this one: it pops the
// thunk pushed just before it runs. LIFO is what makes a nested call safe — one body's tool call can start
// another function before its first await, inside the outer script — each run taking its own thunk.
const invoke = new vm.Script(`globalThis[Symbol.for(${JSON.stringify(PENDING)})].pop()()`, { filename: 'tool_function' });

/**
 * A {@link FunctionRunner} over `node:vm`: runs in THIS context, so a body keeps the globals it has today
 * (`fetch`, timers, `console`), and bounds each call's synchronous run from its start to its first await.
 *
 * Code after an await is NOT bounded, because a vm timeout covers only the evaluation it is given and an
 * async body's evaluation ends at that await. Covering it needs a context per run in `afterEvaluate` mode,
 * with continuations drained inside timed evaluations — which works, but a timeout that lands during that
 * drain aborts the whole process whenever async hooks are enabled (nodejs/node#38503, closed unfixed).
 * matbot enables none, but the test runner does and any instrumentation might, and a guard that can kill
 * the daemon is worse than the freeze it prevents. An aborted call at least stops such a body's tool calls.
 *
 * It also narrows what a body can reach. `vm` is not a capability boundary — this runs in THIS context —
 * but a body is meant to be a constrained place to compute, and an install that chose `docker-bash` over
 * `bash` has not chosen to hand `node:fs` to model-authored code. Two parts:
 *
 *   - {@link SHADOWED} globals are bound to `undefined` in the wrapper. `process.getBuiltinModule('node:fs')`
 *     reaches every builtin with no import at all, so without this the import gate would be decorative.
 *   - no `importModuleDynamically` is installed, which makes `import()` itself inert — measurably through
 *     every route, including `eval` and both Function constructors, since dynamically-constructed code
 *     inherits the absence. `function-tools` rewrites a body's `import(…)` onto an injected, gated loader
 *     and calls {@link import} below, so the decision happens in matbot's own code.
 *
 * Stated honestly, because it is not a sandbox: `(()=>{}).constructor('return process')()` recovers the
 * real `process` in one line, and the idiom is in every escape writeup ever published. This raises the
 * cost of unauthorised access from "call a documented API" to "know a published trick", and makes the
 * intended path gated, configurable and revocable. An install needing a real boundary runs bodies in
 * another process.
 */
export function createVmFunctionRunner(
  limitMs = FUNCTION_SYNC_LIMIT_MS,
  imports: { permit?: readonly string[]; dotPlugins?: string } = {},
): FunctionRunner {
  const slot = globalThis as unknown as Record<symbol, Array<() => Promise<unknown>> | undefined>;
  const stack = (slot[Symbol.for(PENDING)] ??= []);
  return {
    // Absent must stay ABSENT, not become `[]`: an empty list is the configured "never", while no key at
    // all means unrestricted-and-ask. Collapsing the two is what made an unconfigured install refuse
    // every import without a prompt.
    ...(imports.permit !== undefined ? { permittedImports: imports.permit } : {}),
    // Reached only after the gate has allowed this specifier for this function; it checks nothing itself.
    // An http(s) URL is materialised under `.plugins/` and imported from disk, because node refuses the
    // scheme outright. Everything else goes to a plain dynamic import, which picks up the CLI's own hooks
    // — so a granted `.ts` path is stripped and a `.js` one remaps, exactly as a plugin's import does.
    async import(spec: string): Promise<unknown> {
      if (/^https?:/i.test(spec)) {
        if (imports.dotPlugins === undefined) throw new Error(`Cannot import "${spec}": no plugin cache directory is configured.`);
        const { materialiseUrl } = await import('../remote-loader.js') as { materialiseUrl: (u: string, d: string) => Promise<string> };
        return import(await materialiseUrl(spec, imports.dotPlugins));
      }
      return import(spec);
    },
    compile(params, body) {
      // The shadows are an outer wrapper's parameters, called with nothing: a parameter shadows a global
      // lexically for the whole body, and binding them here rather than assigning inside the body keeps
      // them unassignable from it. A body's own parameter never collides — `parseSignature` rejects a
      // name already in `INJECTED`, and these are not identifiers a signature can introduce anyway.
      const outer = vm.runInThisContext(
        `(function (${SHADOWED.join(', ')}) { return async function (${params.join(', ')}) {\n${body}\n}; })`,
        { filename: 'tool_function' },
      ) as (...shadows: undefined[]) => (...args: unknown[]) => Promise<unknown>;
      const fn = outer();
      return (...args) => {
        const depth = stack.length;
        let started: Promise<unknown> | undefined;
        stack.push(() => (started = fn(...args)));
        let pending: Promise<unknown>;
        try {
          pending = invoke.runInThisContext({ timeout: limitMs }) as Promise<unknown>;
        } catch (e) {
          if ((e as { code?: unknown }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Promise.reject(e);
          pending = Promise.reject(Object.assign(
            new Error(`Stopped after ${limitMs / 1000}s of synchronous work without an await — most likely a loop that never ends. A function may compute between awaits, but not for this long.`),
            { code: FUNCTION_TIMEOUT },
          ));
        } finally {
          // Stopped code skips its own finally blocks, so a thunk pushed inside it may never have been
          // popped; trimming to this call's depth keeps the next call from running a stale one.
          stack.length = depth;
        }
        // When a run is stopped, promises it had already created are dropped with it — the body's own
        // (which may have adopted a nested run's rejection) and the timeout's. Nobody awaits them, and an
        // unhandled rejection would take the whole process down. Marked here, outside the stopped script,
        // so this always runs; whoever does await `pending` still sees the rejection.
        const noop = (): void => { /* reported through `pending`, or by the enclosing run */ };
        started?.catch(noop);
        pending.catch(noop);
        return pending;
      };
    },
  };
}
