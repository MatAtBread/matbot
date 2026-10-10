import vm from 'node:vm';
import { FUNCTION_TIMEOUT, type FunctionRunner } from '@matatbread/matbot-core';

// The default, when `function_timeout_ms` is absent from matbot.yaml. Far past any legitimate stretch of
// computation between two awaits, and short enough that the daemon is back before anyone concludes it died.
export const FUNCTION_SYNC_LIMIT_MS = 10_000;

const PENDING = 'matbot.functionRunner.pending';

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
 * A body reaches node through a dynamic `import()`, enabled by `USE_MAIN_CONTEXT_DEFAULT_LOADER` below.
 * This grants nothing: running in this context, a body already reaches every builtin through
 * `process.getBuiltinModule('node:fs')`. It makes the ergonomic form work and, with node's types loaded
 * by the check gate, the typed one — `vm` is not and never was a capability boundary here.
 */
export function createVmFunctionRunner(limitMs = FUNCTION_SYNC_LIMIT_MS): FunctionRunner {
  const slot = globalThis as unknown as Record<symbol, Array<() => Promise<unknown>> | undefined>;
  const stack = (slot[Symbol.for(PENDING)] ??= []);
  return {
    compile(params, body) {
      // The option belongs on the compile of the BODY, not on `invoke`: the referrer of an `import()` is
      // the script that created the enclosing function, not the one that happens to call it. It routes
      // through the main context's own ESM loader, so the CLI's registered hooks apply — the .js→.ts
      // remap, type stripping, `?mbfresh=` propagation and `.plugins/` fetching all behave as for a
      // plugin import. `filename` stays a bare name: it is what a stack frame shows an author repairing
      // the body, at the cost of relative specifiers resolving against the process working directory
      // (the `matbot.yaml` directory) rather than against anything the body can see.
      const fn = vm.runInThisContext(`(async function (${params.join(', ')}) {\n${body}\n})`, {
        filename: 'tool_function',
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }) as (...args: unknown[]) => Promise<unknown>;
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
