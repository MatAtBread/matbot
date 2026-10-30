import { FUNCTION_TIMEOUT, importPermitted, importableByName, makeToolBox, refusalMessage } from '@matatbread/matbot-plugin-api';
import { DefinitionError, stripLeadingTrivia } from './signature.js';
import { gatedNetwork, type Asker } from './network.js';
import type { MatbotMachine, ComposedCallContext, FunctionCall, FunctionRunSettings, FunctionRunner, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

/** The invocation's own part first — the gated loader and the settings read for it, which are the
 *  runner's to wire, not bindings the body names — then the ambient values a body has in scope, then its
 *  own arguments. */
export type CompiledFn = (call: FunctionCall, tool: unknown, toolInContext: unknown, context: ComposedCallContext, ...args: unknown[]) => Promise<unknown>;

/** The gated loader a body's `import(…)` reaches, whatever the runner resolves it to. `options` is the
 *  import's own second argument (import attributes), carried through untouched. */
export type ImportFn = (spec: string, options?: ImportCallOptions) => Promise<unknown>;

/** The ambient values a body has in scope, and so the names its own parameters may not take. Declared in
 *  the generated `.d.ts` as globals of the matching type, which is how an author knows they exist. */
export const INJECTED = ['tool', 'toolInContext', 'context'] as const;

/** What compiling and running model-authored code reads from the host: the runner, at every call — and the
 *  stripper, used only where there is no runner, since `new AsyncFunction` cannot take TypeScript. */
export type CompileHost = Pick<MatbotMachine, 'TypeScriptStripper' | 'FunctionRunner'>;

export const TOOL_NAME = 'tool_function';

const LEADING = /^\s*(?:async\s+)?(?:function\s+)?/;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const CANCELLED = 'Cancelled: the call was aborted while the function was still running.';

/**
 * Compile a method-shorthand function definition into a runnable async function. The definition is
 * wrapped as an immediately-returned function expression — `(async function <rest>)(...args)` — so a
 * leading `async` or `function` keyword is stripped and the named form constructs through one path; the
 * body-only form (no head at all) goes through {@link buildBodyFn} instead. Everything runs async so tool
 * calls inside can be awaited; `tool` is the proxy passed as the first argument. Type
 * erasure is delegated to the host-provided {@link TypeScriptStripper} (node's native stripper or the
 * browser's sucrase), so this stays platform-agnostic; because that strip may be async, so is this.
 * The result runs under whichever {@link FunctionRunner} is current at each call; see {@link compileUnder}.
 */
export async function buildAsyncFn(host: CompileHost, definition: string, paramNames: string[]): Promise<CompiledFn> {
  // Leading trivia goes first: a doc comment ahead of the definition would otherwise land between
  // `function` and the name, which is a syntax error rather than the harmless prose it looks like.
  // The newline before `)` here and in buildBodyFn: a definition ending in a line comment would otherwise
  // comment out the closing parenthesis, and a body that typechecked would be refused as invalid.
  const wrapped = `(async function ${stripLeadingTrivia(definition).replace(LEADING, '')}\n)`;
  return compileUnder(host, [...INJECTED, ...paramNames], await erase(host, wrapped),
                      code => `return ${code}(${paramNames.join(', ')});`) as CompiledFn;
}

/**
 * Defer a compile to the first call: what a reload hands the registry for a definition that was already
 * compiled when it was defined. Boot cost was all compile — the strip, the runner's parse, and the
 * runner's first `require('typescript')`, measured at ~0.2s for one stored function and ~2.5s for 200
 * large ones — for functions most turns never call. A failed build is not kept, so a later call (under a
 * runner registered since, say) tries again.
 */
export function onFirstCall<A extends unknown[]>(build: () => Promise<(...args: A) => Promise<unknown>>): (...args: A) => Promise<unknown> {
  let built: Promise<(...args: A) => Promise<unknown>> | undefined;
  return (...args) => (built ??= build().catch((e: unknown) => { built = undefined; throw e; })).then(fn => fn(...args));
}

/**
 * Compile `body` under the host's current {@link FunctionRunner}, and again at a call that finds a different
 * one. A runner's bound lives in the function it returns, so a compiled body cannot be handed to another;
 * and a defined function is compiled once and then called for as long as it stays registered, across any
 * number of runner registrations — a runner registered later must reach it, and one withdrawn (its plugin
 * unloaded, reverting to the host's) must not stay on. Only this step is redone: the strip does not depend
 * on the runner.
 *
 * Compiled eagerly too, so a syntax error is reported at definition rather than at first call.
 */
/**
 * Compile a bare statement block into a runnable async function — the `execute` form, whose definition IS
 * its body. There is no head to strip, so the block is appended to a synthesised empty one and the braces
 * the author wrote become the function's own.
 *
 * Requiring the braces is load-bearing rather than a parsing convenience. An arrow head is a legal
 * *expression statement*, so a tolerantly-wrapped `(args) => { … }` would compile, evaluate and discard
 * the function, and return `undefined` — a silent `null` on the wire that reads exactly like a body which
 * chose to return nothing. Demanding the `{` turns that into a reported error that names the fix, which is
 * the whole point of the form: with no head to write there is no arrow to write either.
 */
export async function buildBodyFn(host: CompileHost, definition: string): Promise<CompiledFn> {
  const src = stripLeadingTrivia(definition);
  if (!src.startsWith('{')) {
    throw new DefinitionError(
      'execute takes a bare BODY, not a function: write the statements between braces, e.g. ' +
      "`{ const xs = await tool.x({}); return xs.length; }`" +
      '. There is no function head, no parameter list and no `=>` — an arrow form would compile and then return nothing at all.',
    );
  }
  const wrapped = `(async function () ${src}\n)`;
  return compileUnder(host, INJECTED, await erase(host, wrapped), code => `return ${code}();`) as CompiledFn;
}

/**
 * One definition in both forms: as written, and erased. A {@link FunctionRunner} is handed the TypeScript,
 * because erasure is part of running it and the runner may not even do it that way. The erased form is
 * kept for the case where there is no runner — `new AsyncFunction` cannot take TypeScript — and because
 * erasing is what reports "not valid TypeScript" at DEFINITION, naming the real fault, instead of a
 * "could not compile" from whatever a runner makes of it later.
 */
export interface Definition { ts: string; js: string }

export async function erase(host: CompileHost, ts: string): Promise<Definition> {
  try { return { ts, js: await host.TypeScriptStripper.strip(ts) }; }
  catch (e) { throw new DefinitionError(`not valid TypeScript (${msg(e)})`); }
}

export function compileUnder(
  host: Pick<MatbotMachine, 'FunctionRunner'>,
  names: readonly string[],
  def: Definition,
  buildBody: (code: string) => string,
): CompiledFn {
  // What a runner is handed: one self-contained async-function EXPRESSION, parameters and all, so it is
  // strippable and parseable as it stands. The callable's own argument list is this package's convention
  // and appears nowhere in the contract.
  // Only the ambient names. The loader is not a parameter here: it reaches each call through the runner,
  // which binds it to an identifier of its own choosing — so this package never names it and an author
  // never sees it.
  const expr = (code: string): string => `(async function (${names.join(', ')}) {\n${buildBody(code)}\n})`;
  const compile = (runner: FunctionRunner | undefined): CompiledFn => {
    try {
      if (runner !== undefined) return runner.compile(expr(def.ts)) as CompiledFn;
      // No runner: nothing bounds the body, nothing is withheld from it, and nothing rewrites its
      // `import(…)` — so the loader is never reached and the body's import gets whatever the platform
      // resolves. The ambient values are ordinary arguments, so the loader is dropped in front of them.
      const plain = (new Function(`return ${expr(def.js)};`) as () => (...args: unknown[]) => Promise<unknown>)();
      return (_call, ...args) => plain(...args);
    } catch (e) { throw new Error(`could not compile (${msg(e)})`); }
  };
  let runner = host.FunctionRunner;
  let fn = compile(runner);
  return (...args: Parameters<CompiledFn>) => {
    // Recompiled against whatever runner is current, not the one at definition: a runner registered later
    // must reach a body already defined, and one withdrawn must not stay on. Its whole environment rides
    // on this — the bound, the withheld globals, and whether `import(…)` reaches the gate at all.
    const current = host.FunctionRunner;
    if (current !== runner) {
      try { fn = compile(current); } catch (e) { return Promise.reject(e); }
      runner = current;
    }
    return fn(...args);
  };
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
/**
 * The loader a rewritten `import(…)` lands on: one {@link PermissionGate} decision per specifier per
 * function, then the host's own way of turning a specifier into a module.
 *
 * The subject names the function as well as the module, because the decision is two-dimensional and the
 * specifier alone throws away the signal that matters — a brand-new function would inherit every grant
 * an older, reviewed one had earned, and "why is THIS function asking for `node:fs`?" is the question a
 * human is being asked. An `execute` body has no name to key on, so it keys as `#execute`: a standing
 * answer there covers every one-off body, which the label says outright rather than implying narrowness
 * it cannot deliver.
 *
 * A defined function is named by name AND version ({@link versionedSubject}), so redefining it — the one
 * door the model controls — asks again rather than inheriting what the reviewed version was granted. The
 * cost is a question per attempt while a model iterates on a body; the grant that spans versions is the
 * user's to give, as the "any function" standing answer.
 *
 * Only a builtin or an installed package is ever asked about ({@link importableByName}): a path or a URL
 * is refused without a prompt, because downloading or placing code is a plugin install's job, not a
 * body's. A configured `permittedImports` RESTRICTION is checked next, so a specifier an installation
 * forbids outright is refused without a prompt too — there is nothing to ask about there. With none configured, which
 * is the default, every specifier reaches the gate: a restriction that defaulted to empty would refuse
 * before anyone could be asked, which is the behaviour a permission prompt exists to replace.
 */
function gatedImport(machine: MatbotMachine, ctx: ToolContext, asker: Asker, settings: FunctionRunSettings | undefined): ImportFn {
  // One decision per specifier per invocation. A body that imports inside a loop would otherwise ask —
  // and read the policy's settings document — once per iteration, and a DENIED one would re-prompt a
  // human on every pass. Scoped to this closure, which `runFunction` builds per call, so a standing
  // answer given or withdrawn between calls is still seen. Only the DECISION is kept: the load itself
  // takes this call's options, and the module cache already makes a repeat import cheap.
  const decided = new Map<string, Promise<void>>();
  return async (written: string, options?: ImportCallOptions): Promise<unknown> => {
    if (typeof written !== 'string' || written === '') throw new Error('import needs a module specifier.');
    // Canonical before anything decides, so `os` and `node:os` are one question, one grant and one label.
    const spec = machine.FunctionRunner?.canonicalImport?.(written) ?? written;
    let decision = decided.get(spec);
    if (decision === undefined) {
      decision = decide(ctx, asker, spec, settings?.permittedImports);
      decided.set(spec, decision);
    }
    await decision;
    const runner = machine.FunctionRunner;
    return runner?.import !== undefined ? runner.import(spec, options) : import(spec, options);
  };
}

async function decide(ctx: ToolContext, { namespace, fn, who }: Asker, spec: string, permits: readonly string[] | undefined): Promise<void> {
  if (!importableByName(spec)) {
    throw new Error(
      `Cannot import '${spec}': a function body imports only node builtins ('node:fs') and packages already ` +
      'installed where matbot runs, by name — never a path or a URL. To use other code, install it as a ' +
      'package, or as a matbot plugin with the `plugin` tool.',
    );
  }
  if (permits !== undefined && !importPermitted(permits, spec)) {
    throw new Error(
      `Import of '${spec}' is not permitted on this installation` +
      (permits.length === 0
        ? ' — module imports are switched off on this installation.'
        : `, which allows only: ${permits.join(', ')}.`),
    );
  }
  // Every grant is a broad one, builtins included: `node:child_process` runs programs, `node:module` hands
  // back `require`, and `node:process` is the very global the runner withholds. A package is broader again,
  // being loaded as host code: the runner does not compile it, so none of a body's withheld globals apply
  // to it, and its own imports are never gated, so one answer covers the whole closure. The label says so.
  const builtin = spec.startsWith('node:');
  const label = builtin
    ? `Allow ${who} to import **${spec}**? It gets whatever that module can do, with matbot's full access.`
    : `Allow ${who} to import **${spec}** and everything it imports? Imported code runs with matbot's full access, not the function's.`;
  // Asked under `tool_function`, not the function's own name: that name is the MODEL's, so a gate qualified
  // by it would mint a fresh id per definition, and a standing answer for "any function" filed under one
  // would never be read by another. Which function asked lives in the subject instead.
  const permit = await ctx.gate({ namespace, gate: 'import', subject: `${fn} ${spec}`, label, fallback: false,
                                  standing: standingAnswers(fn, who, spec) });
  if (!permit.allowed) {
    // The source rides in the message because this one surfaces as a thrown error inside a body the
    // model wrote, where "not permitted" alone reads as something to be debugged or routed around.
    throw new Error(refusalMessage(permit, `Import of '${spec}'`));
  }
}

/**
 * Who is asking, for every gate a body reaches. The subject is `<name>@<version>`, the version a digest of
 * the text that was COMPILED — computed here, from what this layer holds, never from anything the body
 * reports about itself (`Function.prototype.toString` is the body's to override). So any change to a
 * definition, by any route, is a different subject. `@` cannot appear in a function name.
 *
 * `resolve` maps that subject to the one its grants are filed under: the first version of the lineage it
 * descends from by edits the user permitted to keep them (see `Lineage`), else itself. An `execute` body
 * keeps its fixed `#execute`: it has no identity to version, and its label already says a standing answer
 * covers every one-off body.
 */
async function askerFor(label: { tool: string; compiled: string; resolve?: (versioned: string) => Promise<string> } | undefined): Promise<Asker> {
  if (label === undefined) return { namespace: TOOL_NAME, fn: EXECUTE_SUBJECT, who: 'a one-off function body' };
  const versioned = await versionedSubject(label.tool, label.compiled);
  return { namespace: TOOL_NAME, fn: label.resolve !== undefined ? await label.resolve(versioned) : versioned, who: `function "${label.tool}"` };
}

/** `<name>@<version>`: the version is the first 128 bits of the SHA-256 of `compiled`, enough that no body
 *  can be searched for that collides with an approved one. */
export async function versionedSubject(name: string, compiled: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(compiled)));
  return `${name}@${[...digest.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The function part of a subject for an `execute` body, which has no name of its own. Not a bare
 *  `execute`: a DEFINED function may legitimately be called that, and would then share one-off bodies'
 *  standing answers in both directions. `#` cannot start a JS identifier, so no function name reaches it. */
export const EXECUTE_SUBJECT = '#execute';

/**
 * The standing answers this import may be remembered as, narrowest first: this exact module, anything
 * under its directory, any builtin (for a `node:` one), then the module across every function.
 *
 * Each carries its own prose. A subject is a KEY — stable, unambiguous, and parsed by nobody — and keys
 * make terrible questions: `#execute node:fs/` is correct and unreadable. Only here is it known that `#`
 * means "a one-off body", that `node:` means "any builtin" and that a trailing slash means "anything
 * under"; a policy rendering the raw subject can only ever show the key.
 *
 * Both the directory AND `node:` are offered where they differ, rather than one chosen by the
 * specifier's shape — picking by shape made the available answer depend on which module a function
 * happened to import first, so `node:fs/promises` offered "any fs submodule" and never "any builtin",
 * while `node:os` offered the reverse.
 *
 * What is NOT offered is the product of the two axes: there is no "any function, any builtin", because
 * the options would multiply past what a prompt can carry. Install-wide breadth is the runner's import restriction
 * and, for a policy, the gate-wide standing answer — both installation authoring, which belongs in yaml
 * rather than in an answer to a prompt.
 */
function standingAnswers(fnName: string, who: string, spec: string): { subject: string; label: string }[] {
  // Only for a SUBPATH, cut at its last `/`. A scoped package's root has a `/` of its own, and cutting
  // `@aws-sdk/client-s3` there offered every package in the `@aws-sdk` scope as "anything under".
  const root = spec.split('/', spec.startsWith('@') ? 2 : 1).join('/');
  const dir = spec !== root ? spec.slice(0, spec.lastIndexOf('/') + 1) : undefined;
  const out = [{ subject: `${fnName} ${spec}`, label: `Always allow ${who} to import ${spec}` }];
  if (dir !== undefined) {
    out.push({ subject: `${fnName} ${dir}`, label: `Always allow ${who} to import anything under ${dir}` });
  }
  if (spec.startsWith('node:')) {
    out.push({ subject: `${fnName} node:`, label: `Always allow ${who} to import any node builtin` });
  }
  out.push({ subject: `* ${spec}`, label: `Always allow ANY function to import ${spec}` });
  return out;
}

export async function* runFunction(
  machine:   MatbotMachine,
  ctx:       ToolContext,
  fn:        CompiledFn,
  argValues: unknown[],
  label?:    { tool: string; source: string; compiled?: string; gateSubject?: string; resolve?: (versioned: string) => Promise<string> },
): AsyncIterable<ToolEvent> {
  const queue: ToolEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (ev: ToolEvent): void => { queue.push(ev); const w = wake; wake = null; w?.(); };

  const runner = machine.FunctionRunner;
  const { tool, toolInContext } = makeToolBox(machine, {
    session: ctx.session,
    signal:  ctx.signal,
    prompt:  ctx.prompt,
    ...(ctx.provider  !== undefined ? { provider:  ctx.provider  } : {}),
    // How a body reaches this session's own functions: they are never registered, so `tool.x()` finds
    // them only by carrying the turn's tools down, as the runner handed them to this call.
    ...(ctx.turnTools !== undefined ? { turnTools: ctx.turnTools } : {}),
  }, {
    onEvent: emit,
    // The runner's, read once for this call: its tool calls are host code acting for the body, which a
    // runner that tells the two apart must not count as the body's.
    ...(runner?.hostCall !== undefined ? { hostCall: <T>(fn: () => T): T => runner.hostCall!(fn) } : {}),
  });

  const context: ComposedCallContext = {
    callId:    ctx.callId,
    sessionId: ctx.session.id,
    signal:    ctx.signal,
    // Normalised here rather than in each renderer: this is the boundary where a model-authored body
    // hands over a number, and `i / n * 100` is the obvious way to compute one. The CLI prints it raw.
    progress:  (pct, message) => emit({
      type: 'progress',
      pct:  Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
      // A string now, while the body is the caller: an object here would be stringified later, by
      // whoever draws the event, running the body's `toString` as theirs.
      ...(message !== undefined && message !== '' ? { message: String(message) } : {}),
    }),
    ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
    ...(ctx.workdir  !== undefined ? { workdir:  ctx.workdir  } : {}),
  };

  // The runner's settings, read ONCE for this whole invocation and held here: the gate and the runner's
  // own bound then answer from the same reading, under the one principal an invocation has throughout.
  // Not cached beyond it, because whose settings they are is the settings store's business — partitioned
  // by principal or not at all — and the next invocation may be someone else's. Read ahead of the abort
  // check and the listener, so an abort during the read still stops the body starting, and a read that
  // throws has no listener to leave behind.
  // `gateSubject` marks an `execute` body, whose label is prose ("tool_function execute"), not a name.
  const asker = await askerFor(label === undefined || label.gateSubject !== undefined ? undefined
                               : { tool: label.tool, compiled: label.compiled ?? label.source, ...(label.resolve !== undefined ? { resolve: label.resolve } : {}) });
  let settings: FunctionRunSettings | undefined;
  try { settings = await machine.FunctionRunner?.settings?.(); }
  catch (e) { yield { type: 'error', message: `could not read the function runner's settings (${msg(e)})` }; return; }
  if (ctx.signal.aborted) { yield { type: 'error', message: CANCELLED }; return; }
  let done = false;
  let cancelled = false;
  let errored = false;
  let result: unknown;
  let error: unknown;
  const settle = (): void => { const w = wake; wake = null; w?.(); };
  // Stop waiting once the call is aborted. The body itself cannot be stopped from here — a pending await
  // is not interruptible — but its tool calls now refuse to start, and nothing waits on it any longer.
  const onAbort = (): void => { cancelled = true; settle(); };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const importModule = gatedImport(machine, ctx, asker, settings);
  const network = gatedNetwork(ctx, asker);
  void fn({ importModule, ...network, ...(settings !== undefined ? { settings } : {}) },
          tool, toolInContext, context, ...argValues)
    .then(v => { result = v; }, e => { errored = true; error = e; })
    .finally(() => { done = true; settle(); });

  try {
    for (;;) {
      while (queue.length > 0) { const ev = queue.shift(); if (ev !== undefined) yield ev; }
      if (done || cancelled) break;
      await new Promise<void>(r => { wake = r; });
    }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
  if (!done) { yield { type: 'error', message: CANCELLED }; return; }
  if (errored) {
    // The caller sees the error; the process log otherwise would not, which left a session's activity
    // spans as the only trace of a runaway that had frozen everything. Named here because only this layer
    // knows which function it was.
    if ((error as { code?: unknown } | null)?.code === FUNCTION_TIMEOUT) {
      const first = (label?.source.trim().split('\n')[0] ?? '').slice(0, 160);
      console.warn(`[function-tools] stopped ${label?.tool ?? 'a function'} (session ${ctx.session.id}, call ${ctx.callId}): ${msg(error)}${first !== '' ? ` Definition: \`${first}\`` : ''}`);
    }
    yield { type: 'error', message: msg(error) };
    return;
  }
  // `undefined` is "no result", not "a result that is undefined": a composition that returns nothing
  // yields no `result` event, exactly like a hand-written tool whose work is a side-effect. This is the
  // difference between a silent verdict and a noisy one — the triggers dispatcher fires only on a
  // yielded result, so a composition used as a trigger's `invoke` could not stay silent while it always
  // yielded. Downstream already expects result-less tools (the Anthropic converter names one).
  if (result !== undefined) yield { type: 'result', value: result };
}
