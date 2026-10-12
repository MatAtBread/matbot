import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FUNCTION_TIMEOUT, type FunctionRunner } from '@matatbread/matbot-plugin-api';
import { ROUTE, transformBody } from './body-transform.js';

// The default, when `function_timeout_ms` is absent from matbot.yaml. Far past any legitimate stretch of
// computation between two awaits, and short enough that the daemon is back before anyone concludes it died.
export const FUNCTION_SYNC_LIMIT_MS = 10_000;

const PENDING = 'matbot.functionRunner.pending';

/**
 * Globals bound to `undefined` for a body, in two kinds because a consumer may want to word them
 * differently.
 * {@link WITHHELD} genuinely EXIST here and are being kept away — `eval` and `Function` among them,
 * knowing that `.constructor` reaches the latter anyway. {@link PHANTOM} never existed in a bare function
 * expression at all, and are shadowed so that node's types — which the check gate loads to type
 * `import('node:…')` — cannot make one of them typecheck and then fail at the first call.
 *
 * One list, read twice: bound here, and published as `withheldGlobals` so a checker can REJECT these
 * rather than keeping a copy that cannot be kept in step — a name shadowed but not rejected typechecks
 * and then fails at the first call.
 *
 * `console`, `fetch` and the timers are deliberately absent: a body legitimately logs, waits and makes
 * requests, and `fetch` means network access is NOT what this withholds.
 */
const WITHHELD = ['process', 'globalThis', 'global', 'Buffer', 'eval', 'Function'] as const;
const PHANTOM  = ['require', 'module', 'exports', '__dirname', '__filename'] as const;
const SHADOWED = [...WITHHELD, ...PHANTOM] as const;

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
 *     inherits the absence. A body's own `import(…)` is routed onto an injected, gated loader — this
 *     runner finds the calls ({@link importCallSpans}), its consumer names them — and arrives at
 *     {@link import} below, so the decision happens in matbot's
 *     own code. (Installing the hook and gating THERE — letting the engine's own parser find the calls,
 *     with no rewrite at all — would be better still, and is not available: a function callback needs
 *     `--experimental-vm-modules`, and `USE_MAIN_CONTEXT_DEFAULT_LOADER` is accepted only as the option
 *     itself, where it gates nothing.)
 *
 * Stated honestly, because it is not a sandbox: `(()=>{}).constructor('return process')()` recovers the
 * real `process` in one line, and the idiom is in every escape writeup ever published. This raises the
 * cost of unauthorised access from "call a documented API" to "know a published trick", and makes the
 * intended path gated, configurable and revocable. An install needing a real boundary runs bodies in
 * another process.
 *
 * `limitMs` of `0` removes the TIME bound and nothing else. That matters because the two were once the
 * same switch: `function_timeout_ms: 0` seeded no runner at all, which is a documented way to run bodies
 * unbounded — and silently took `function_imports.permit` with it, `permit: []` included, along with the
 * withheld globals and the inert `import()`. One line of yaml about how long a body may compute is not
 * an answer to what a body may reach.
 */
export function createVmFunctionRunner(
  limitMs = FUNCTION_SYNC_LIMIT_MS,
  imports: { permit?: readonly string[]; projectDir?: string } = {},
): FunctionRunner {
  const projectDir = imports.projectDir;
  const slot = globalThis as unknown as Record<symbol, Array<() => Promise<unknown>> | undefined>;
  const stack = (slot[Symbol.for(PENDING)] ??= []);
  return {
    // Absent must stay ABSENT, not become `[]`: an empty list is the configured "never", while no key at
    // all means unrestricted-and-ask. Collapsing the two is what made an unconfigured install refuse
    // every import without a prompt.
    ...(imports.permit !== undefined ? { permittedImports: imports.permit } : {}),
    // Reached only after the gate has allowed this specifier for this function; it checks nothing itself.
    // An http(s) URL is materialised under `.plugins/` and imported from disk, because node refuses the
    // scheme outright. Everything else goes to a dynamic import, which picks up the CLI's own hooks — so
    // a granted `.ts` path is stripped and a `.js` one remaps, exactly as a plugin's import does.
    async import(spec: string): Promise<unknown> {
      // An http(s) URL is refused here, not materialised. Fetching one to disk and importing it from
      // there is the host's machinery (`apps/cli`'s remote cache, which the module hooks also read), and
      // a plugin cannot reach into an app — nor should it keep a second copy of the URL-to-path mapping,
      // which has a known collision of its own. So this says so plainly instead of half-doing it.
      if (/^https?:/i.test(spec)) {
        throw new Error(`Cannot import "${spec}": this runner does not fetch remote modules. Install the package where matbot can see it and import it by name.`);
      }
      // A PATH is resolved against the PROJECT — the directory holding matbot.yaml — and not against this
      // file, which is what it would otherwise mean: a path inside the runner's own source, where a body's
      // author cannot have put anything.
      //
      // A BARE specifier is left to ordinary resolution from here, which reaches the project's own
      // `node_modules` whenever matbot is installed inside it — a flat npm or yarn install — and matbot's
      // own packages either way. Under pnpm this file sits outside the project's tree, so a package the
      // user installed beside their config is not reachable; the alternatives are a CJS resolve rooted at
      // the project, which refuses a package whose `exports` offers only an `import` condition (most of
      // them now), or performing the import from a module written into the project, which is a lot of
      // machinery for a package manager's layout. `import.meta.resolve`'s second argument would settle it
      // and is silently ignored, resolving against the wrong base and reporting nothing.
      let target = projectTarget(projectDir, spec);
      if (target === spec && projectDir !== undefined) {
        // Resolved before importing so that "this specifier names nothing" is told apart from "the module
        // loaded and failed": both are ERR_MODULE_NOT_FOUND from an `import`, and a module whose OWN
        // dependency is missing would otherwise be reported as not installed itself.
        try { target = import.meta.resolve(spec); }
        catch {
          throw new Error(`Cannot import "${spec}": it is not installed where matbot can see it. Install it in ${projectDir}, where matbot.yaml is.`);
        }
      }
      try { return await import(target); }
      catch (e) {
        // Only when the missing thing IS what was asked for: `url` is the specifier node could not find,
        // so a module whose own dependency is missing keeps its own error rather than being reported as
        // absent itself.
        if ((e as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && (e as { url?: unknown }).url === target) {
          throw new Error(`Cannot import "${spec}": there is no such file. Paths are resolved against ${projectDir ?? 'the working directory'}, where matbot.yaml is.`);
        }
        throw e;
      }
    },
    withheldGlobals: SHADOWED,
    compile(source) {
      // Erasure and the import routing are both this runner's: it is handed a TypeScript expression and
      // what it does to get to something runnable is nobody else's business.
      const fnExpr = transformBody(source);
      // Two wrappers, both parameter lists called with values rather than assignments inside the body, so
      // neither can be reassigned from it. The outer shadows the withheld globals — a parameter shadows a
      // global lexically for the whole body. The inner binds the loader this runner was handed to the
      // name its own rewrite used; that name is private to this file, which is why a body may have a
      // parameter called the same thing.
      const outer = vm.runInThisContext(
        `(function (${SHADOWED.join(', ')}) { return function (${ROUTE}) { return (${fnExpr}); }; })`,
        { filename: 'tool_function' },
      ) as (...shadows: undefined[]) => (route: unknown) => (...args: unknown[]) => Promise<unknown>;
      const bind = outer();
      return (importModule, ...args) => {
        // A fresh inner function per call, so interleaved calls cannot tread on one another — a body's
        // tool call can start another function before its first await, which a mutable slot would lose.
        const fn = bind(importModule);
        const depth = stack.length;
        let started: Promise<unknown> | undefined;
        stack.push(() => (started = fn(...args)));
        let pending: Promise<unknown>;
        try {
          // No `timeout` key at all when the bound is off: vm rejects a non-positive one, and this is the
          // only thing `limitMs: 0` turns off.
          pending = invoke.runInThisContext(limitMs > 0 ? { timeout: limitMs } : {}) as Promise<unknown>;
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

/**
 * `spec` as the project would spell it: a relative or absolute path becomes a `file:` URL rooted at the
 * project, and everything else — a bare package, a builtin — is passed through to resolve as it ordinarily
 * would. Returning `spec` unchanged is also what tells the caller it was not a path, so a "not installed"
 * message is only produced for the case it fits.
 */
function projectTarget(projectDir: string | undefined, spec: string): string {
  if (path.isAbsolute(spec)) return pathToFileURL(spec).href;
  if (projectDir === undefined || !/^\.\.?[/\\]/.test(spec)) return spec;
  return pathToFileURL(path.resolve(projectDir, spec)).href;
}
