import { isBuiltin } from 'node:module';
import vm from 'node:vm';
import { FUNCTION_TIMEOUT, importableByName, type FunctionRunSettings, type FunctionRunner } from '@matatbread/matbot-plugin-api';
import { ROUTE, transformBody } from './body-transform.js';
import { BODY_FILE, hostCall, inBody } from './host-only.js';

// The default, when this plugin's `timeout_ms` setting is absent. Far past any legitimate stretch of
// computation between two awaits, and short enough that the daemon is back before anyone concludes it died.
export const FUNCTION_SYNC_LIMIT_MS = 10_000;

const PENDING = 'matbot.functionRunner.pending';

/**
 * Globals bound to `undefined` for a body, in two kinds because a consumer may want to word them
 * differently.
 * {@link WITHHELD} genuinely EXIST here and are being kept away. `Function` is not among them: a name
 * cannot keep a body from it, every function's `.constructor` being the same object, so the object itself
 * refuses a body instead (`host-only.ts`). `eval` is, because replacing the global would change what a
 * DIRECT `eval(…)` means in every library that uses one. {@link PHANTOM} never existed in a bare function
 * expression at all, and are shadowed so that node's types — which the check gate loads to type
 * `import('node:…')` — cannot make one of them typecheck and then fail at the first call.
 *
 * One list, read twice: bound here, and published as `withheldGlobals` so a checker can REJECT these
 * rather than keeping a copy that cannot be kept in step — a name shadowed but not rejected typechecks
 * and then fails at the first call.
 *
 * `console`, `fetch`, `WebSocket` and the timers are deliberately absent: a body legitimately logs, waits
 * and makes requests. The two network globals are REPLACED instead, by the ones each call is handed, which
 * put every origin to a gate.
 *
 * So is `Buffer`, which reaches no capability — it is a view over memory and does no IO — and is the one
 * way to base64 bytes on node 24, which has no `Uint8Array.fromBase64`. Withholding it only put a prompt
 * in front of `import('node:buffer')` that described it as carrying matbot's full access. What it does
 * expose is memory: `Buffer.from('a').buffer` is the whole shared allocation pool and `allocUnsafe` is not
 * zeroed, so a body can read leftover bytes of other recent allocations in this process. That was equally
 * true after the import, and a body that can `fetch` is not being kept from data.
 */
const WITHHELD = ['process', 'globalThis', 'global', 'eval'] as const;
const PHANTOM  = ['require', 'module', 'exports', '__dirname', '__filename'] as const;
const SHADOWED = [...WITHHELD, ...PHANTOM] as const;

// A vm timeout bounds only code started by a vm script, so each call runs through this one: it pops the
// thunk pushed just before it runs. LIFO is what makes a nested call safe — one body's tool call can start
// another function before its first await, inside the outer script — each run taking its own thunk.
const invoke = new vm.Script(`globalThis[Symbol.for(${JSON.stringify(PENDING)})].pop()()`, { filename: BODY_FILE });

/** This runner's reading of its settings: the declared restriction, plus the time bound only it reads. */
export interface VmRunSettings extends FunctionRunSettings {
  readonly timeoutMs: number;
}

/** Where the settings come from, if not the fixed values the runner was built with. Called once per
 *  invocation ({@link FunctionRunner.settings}); `permit` undefined means no restriction. */
export type ReadRunnerSettings = () => Promise<{ timeoutMs: number; permit: readonly string[] | undefined }>;

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
 * `bash` has not chosen to hand `node:fs` to model-authored code. Three parts:
 *
 *   - {@link SHADOWED} globals are bound to `undefined` in the wrapper. `process.getBuiltinModule('node:fs')`
 *     reaches every builtin with no import at all, so without this the import gate would be decorative.
 *   - no `importModuleDynamically` is installed, which makes `import()` itself inert — measurably through
 *     every route, including `eval` and both Function constructors, since dynamically-constructed code
 *     inherits the absence. A body's own `import(…)` is rewritten onto the gated loader each call is
 *     handed ({@link transformBody}), which reaches {@link import} below once the gate allows it, so the
 *     decision happens in matbot's own code. (Installing the hook and gating THERE — letting the engine's own parser find the calls,
 *     with no rewrite at all — would be better still, and is not available: a function callback needs
 *     `--experimental-vm-modules`, and `USE_MAIN_CONTEXT_DEFAULT_LOADER` is accepted only as the option
 *     itself, where it gates nothing.)
 *
 *   - the function constructors and `process.getBuiltinModule` refuse a body, however it reaches them
 *     (`(()=>{}).constructor('return process')()` recovered the real `process` in one line). That
 *     closes the global scope to it, and with it every name shadowed above; see `host-only.ts`.
 *
 * Stated honestly, because it is not a sandbox: a body shares this process's built-ins and can rewrite
 * them — `Object.prototype`, `JSON`, `Headers.prototype` — so code that is trying to interfere with matbot
 * can. What this stops is a body REACHING past the gates, which is what an over-eager model does: the
 * intended path is gated, configurable and revocable, and the other one says why it is closed. A boundary
 * against deliberate tampering needs a context, or a process, of its own.
 *
 * `limitMs` of `0` removes the TIME bound and nothing else. That matters because the two were once the
 * same switch: a timeout of `0` seeded no runner at all, which is a documented way to run bodies
 * unbounded — and silently took the import restriction with it, the empty list included, along with the
 * withheld globals and the inert `import()`. One line of yaml about how long a body may compute is not
 * an answer to what a body may reach.
 */
export function createVmFunctionRunner(
  limitMs = FUNCTION_SYNC_LIMIT_MS,
  imports: { permit?: readonly string[]; projectDir?: string } = {},
  read?: ReadRunnerSettings,
): FunctionRunner {
  const projectDir = imports.projectDir;
  // `isBuiltin` and not a `builtinModules` lookup, because a subpath counts (`fs/promises`) and the
  // prefix-only builtins do not (`test` is a package; only `node:test` is the builtin).
  const canonical = (spec: string): string => !spec.includes(':') && isBuiltin(spec) ? `node:${spec}` : spec;
  const slot = globalThis as unknown as Record<symbol, Array<() => Promise<unknown>> | undefined>;
  const stack = (slot[Symbol.for(PENDING)] ??= []);
  const settingsOf = (timeoutMs: number, permit: readonly string[] | undefined): VmRunSettings => ({
    timeoutMs,
    // Absent must stay ABSENT, not become `[]`: an empty list is the configured "never", while no key at
    // all means unrestricted-and-ask. Collapsing the two is what made an unconfigured install refuse
    // every import without a prompt.
    // Entries are canonicalised as specifiers are, or `['os']` would stop admitting the `os` the gate now
    // asks about as `node:os`. A trailing `/` is the entry's boundary marker, so it is kept off and back on.
    ...(permit !== undefined
      ? { permittedImports: permit.map(p => p.endsWith('/') ? `${canonical(p.slice(0, -1))}/` : canonical(p)) }
      : {}),
  });
  const fixed = settingsOf(limitMs, imports.permit);
  return {
    async settings() {
      if (read === undefined) return fixed;
      const { timeoutMs, permit } = await read();
      return settingsOf(timeoutMs, permit);
    },
    // Reached only after the gate has allowed this specifier for this function, so it checks nothing of
    // the gate's. It does refuse a path or a URL, which the gate never passes: a body imports builtins and
    // installed packages by name, and placing or downloading code is a plugin install's job.
    async import(spec: string, options?: ImportCallOptions): Promise<unknown> {
      if (!importableByName(spec)) {
        throw new Error(`Cannot import "${spec}": a function body imports only node builtins and installed packages, by name.`);
      }
      // Resolved from HERE, which reaches the project's own `node_modules` whenever matbot is installed
      // inside it — a flat npm or yarn install — and matbot's own packages either way. Under pnpm this
      // file sits outside the project's tree, so a package the user installed beside their config is not
      // reachable; the alternatives are a CJS resolve rooted at the project, which refuses a package whose
      // `exports` offers only an `import` condition (most of them now), or performing the import from a
      // module written into the project, which is a lot of machinery for a package manager's layout.
      // `import.meta.resolve`'s second argument would settle it and is silently ignored, resolving against
      // the wrong base and reporting nothing.
      //
      // Resolved before importing so that "this specifier names nothing" is told apart from "the module
      // loaded and failed": both are ERR_MODULE_NOT_FOUND from an `import`, and a module whose OWN
      // dependency is missing would otherwise be reported as not installed itself.
      let target: string;
      try { target = import.meta.resolve(spec); }
      catch {
        throw new Error(`Cannot import "${spec}": it is not installed where matbot can see it.${
          projectDir !== undefined ? ` Install it in ${projectDir}, where matbot.yaml is.` : ''}`);
      }
      // As host code: a module's own top-level may compile code, and it is not the body's.
      return hostCall(() => import(target, options));
    },
    canonicalImport: canonical,
    hostCall,
    withheldGlobals: SHADOWED,
    compile(source) {
      // Erasure and the import routing are both this runner's: it is handed a TypeScript expression and
      // what it does to get to something runnable is nobody else's business.
      const fnExpr = transformBody(source);
      // Two wrappers, both parameter lists called with values rather than assignments inside the body, so
      // neither can be reassigned from it. The outer shadows the withheld globals — a parameter shadows a
      // global lexically for the whole body. The inner binds the loader this runner was handed to the
      // name its own rewrite used; that name is private to this file, which is why a body may have a
      // parameter called the same thing. It binds `fetch` and `WebSocket` too, to the gated pair the call
      // is handed, so a body's own spelling reaches them; `globalThis.fetch` is out of reach with
      // `globalThis`, and code compiled in the global scope, which would see the real ones, is refused.
      // Compiled under BODY_FILE, which is how a function the body declares is told from host code when it
      // is called later — as a `toJSON`, a getter or a listener — outside the call.
      //
      // The inner one is strict, so the body is: called with no receiver, a sloppy body's `this` is the
      // real global, and `this.process` would hand back everything the outer one shadows. Strictness goes
      // on the INNER wrapper because a strict function may not bind `eval` as a parameter, and nests
      // into every function the body declares. The newline keeps a trailing line comment in the body
      // from swallowing the closing parenthesis.
      const outer = vm.runInThisContext(
        `(function (${SHADOWED.join(', ')}) { return function (${ROUTE}, fetch, WebSocket) { 'use strict'; return (${fnExpr}\n); }; })`,
        { filename: BODY_FILE },
      ) as (...shadows: undefined[]) => (route: unknown, f: typeof fetch, ws: typeof WebSocket) => (...args: unknown[]) => Promise<unknown>;
      const bind = outer();
      return (call, ...args) => {
        // A fresh inner function per call, so interleaved calls cannot tread on one another — a body's
        // tool call can start another function before its first await, which a mutable slot would lose.
        const fn = bind(call.importModule, call.fetch ?? fetch, call.WebSocket ?? WebSocket);
        // The bound this invocation read at its start. A value this runner did not produce — or none —
        // carries no `timeoutMs`, and gets the bound the runner was built with.
        const ms = (call.settings as Partial<VmRunSettings> | undefined)?.timeoutMs;
        const limit = typeof ms === 'number' ? ms : limitMs;
        const depth = stack.length;
        let started: Promise<unknown> | undefined;
        stack.push(() => (started = fn(...args)));
        let pending: Promise<unknown>;
        try {
          // No `timeout` key at all when the bound is off: vm rejects a non-positive one, and this is the
          // only thing a bound of 0 turns off.
          pending = inBody(() => invoke.runInThisContext(limit > 0 ? { timeout: limit } : {}) as Promise<unknown>);
        } catch (e) {
          if ((e as { code?: unknown }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Promise.reject(e);
          pending = Promise.reject(Object.assign(
            new Error(`Stopped after ${limit / 1000}s of synchronous work without an await — most likely a loop that never ends. A function may compute between awaits, but not for this long.`),
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
