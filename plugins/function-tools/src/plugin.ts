import { PLUGIN_API_VERSION, notifyingStore, renderToolCheck as renderCheck } from '@matatbread/matbot-plugin-api';
import type {
  JSONSchema, MatbotMachine, MatbotPluginSpec, Store,
  Tool, ToolContext, ToolEvent, ToolContract, ToolResultOf, ToolCheckReport,
} from '@matatbread/matbot-plugin-api';
import { buildAsyncFn, runFunction, INJECTED, type CompiledFn } from './compile.js';
import { parseSignature, paramsSchema, type ParsedParam, type ParsedSignature } from './signature.js';
import { parsePackage, buildPackageFn, exportFn, type ParsedPackage } from './package.js';

const TOOL_NAME         = 'tool_function';
const PLUGIN_NAME       = 'function-tools';
const NAMESPACE         = 'functions';
const PACKAGE_NAMESPACE = 'function-packages';

interface FunctionRecord { name: string; definition: string; description?: string; definedUnchecked?: true }

/** One function's row in a `check` sweep: the service's report, plus who it is about. `diagnostics`
 *  carries each finding's own `rendered` text, so a reader displays that and counts on `total`. */
interface CheckResult extends ToolCheckReport { name: string; package?: true; definedUnchecked?: true }

interface PackageRecord { name: string; tools: string[]; definition: string; definedUnchecked?: true }

/** A stored package, keyed by package name: the unit of declaration AND of removal, so an internal helper
 *  can never outlive the exports calling it, nor an export the helper it calls. */
interface PackageDoc { id: string; version: string; definition: string; definedUnchecked?: true }

/** A stored function. Its `id` IS its name — names are already unique (they are tool-registry keys),
 *  so there is no second identity to keep in step, and a rename is a delete plus an add. */
interface FunctionDoc {
  id: string; version: string; definition: string; description?: string;
  /** This source was registered without ever being type-checked — `noTypeCheck`, or no checker present.
   *  Provenance of the DEFINITION, not a verdict on it: a `check` that passes later does not clear it
   *  (check registers and persists nothing, and the fact it records stays true), which is what keeps the
   *  flag from ever becoming a lie people learn to ignore. */
  definedUnchecked?: true;
}

const recordOf = (doc: FunctionDoc): FunctionRecord => ({
  name: doc.id, definition: doc.definition,
  ...(doc.description !== undefined ? { description: doc.description } : {}),
  ...(doc.definedUnchecked === true ? { definedUnchecked: true } : {}),
});

// Placeholder used as a defined tool's description when the caller supplies none — fill in as desired.
const PLACEHOLDER_DESCRIPTION = 'A user-defined function tool.';

/** The params object's TypeScript type as text — one property per parameter (optional ⇒ `?`). */
function paramsTypeText(params: ParsedParam[]): string {
  return params.length === 0
    ? '{}'
    : `{ ${params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type ?? 'unknown'}`).join('; ')} }`;
}

/** The injected bindings are formals ahead of the function's own, so a parameter of the same name shadows
 *  one — legal (sloppy-mode duplicate formals, last binding wins) and therefore silent: the body would read
 *  its own argument where it wrote `context`. Reject it with the reason instead. */
function assertNoInjectedClash(params: ParsedParam[]): void {
  const clash = params.find(p => (INJECTED as readonly string[]).includes(p.name));
  if (clash === undefined) return;
  throw new Error(`parameter "${clash.name}" collides with an injected binding (${INJECTED.join(', ')}) — inside the body it would shadow it. Rename the parameter.`);
}

/** The type-check snippet for a parsed function: its body as an async fn, checked against the live tool
 *  types via {@link ToolTypeIndex.check}. A declared return type is Promise-wrapped and verified against the
 *  body; without one (a lambda may omit it) TS infers it, still checking the body and its `tool` calls. */
function checkSnippet(sig: ParsedSignature): string {
  if (sig.returnType === undefined) return `async function __fn(${sig.paramsText}) ${sig.body}`;
  const ret = /^Promise\s*</.test(sig.returnType) ? sig.returnType : `Promise<${sig.returnType}>`;
  return `async function __fn(${sig.paramsText}): ${ret} ${sig.body}`;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    tool_function:
      | ToolContract<{ message: string; tool: string; parameters: ParsedParam[] }, { action: 'define'; definition: string; description?: string; noTypeCheck?: boolean }>
      | ToolContract<unknown,                                                      { action: 'lambda'; definition: string; params?: object; noTypeCheck?: boolean }>
      | ToolContract<{ message: string; package: string; tools: string[] },         { action: 'package'; name: string; definition: string; noTypeCheck?: boolean }>
      | ToolContract<{ ok: boolean; checked: boolean; results: CheckResult[] },    { action: 'check';  name?: string; package?: string }>
      | ToolContract<{ functions: FunctionRecord[]; packages: PackageRecord[] },  { action: 'list'   }>
      | ToolContract<{ available: boolean; dts: string },                         { action: 'types'  }>
      | ToolContract<{ message: string },                                         { action: 'remove'; name: string } | { action: 'remove'; package: string }>;
  }
}

type ToolFunctionAction =
  | { action: 'define'; definition: string; description?: string; noTypeCheck?: boolean }
  | { action: 'lambda'; definition: string; params?: unknown; noTypeCheck?: boolean }
  | { action: 'package'; name: string; definition: string; noTypeCheck?: boolean }
  | { action: 'check'; name?: string; package?: string }
  | { action: 'list' }
  | { action: 'types' }
  | { action: 'remove'; name?: string; package?: string };

/**
 * Owns the defined functions: derives+compiles each into a registered tool, and persists the sources
 * as one document per function in the `functions` namespace.
 *
 * There is no in-memory copy of the data — every read goes through the store proxy, so it follows a
 * backend swap and the current principal's partition, and a second writer is seen. The one thing held
 * here is `registered`: the names this plugin has put into the tool registry, which is ownership (what
 * to unregister on reload/teardown), not a cache of the documents.
 */
class FunctionStore {
  private readonly machine: MatbotMachine;
  private readonly store:   Store<FunctionDoc>;
  private readonly registered = new Set<string>();

  constructor(machine: MatbotMachine, store: Store<FunctionDoc>) {
    this.machine = machine;
    this.store   = store;
  }

  /** Register a tool for every stored function, dropping any this plugin registered that is no longer
   *  there. Idempotent, so it serves both boot and a StorageBackend swap (which replaces the whole set). */
  async reload(): Promise<void> {
    const { items } = await this.store.query({ immutable: true });
    const seen = new Set<string>();
    for (const doc of items) {
      try { await this.registerTool(recordOf(doc)); seen.add(doc.id); }
      catch (e) { console.warn(`[${PLUGIN_NAME}] skipping "${doc.id}": ${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const name of this.registered) if (!seen.has(name)) this.machine.tools.remove(name);
    this.registered.clear();
    for (const name of seen) this.registered.add(name);
  }

  async list(): Promise<FunctionRecord[]> {
    const { items } = await this.store.query({ sort: [{ field: 'id', dir: 'asc' }], immutable: true });
    return items.map(recordOf);
  }

  async define(definition: string, description?: string, noTypeCheck = false): Promise<{ name: string; parameters: ParsedParam[] }> {
    const sig = parseSignature(definition);
    if (sig.name === undefined) throw new Error('define requires a NAMED function, e.g. `weather(city: string): string { … }`.');
    if (sig.name === TOOL_NAME) throw new Error(`"${TOOL_NAME}" is reserved.`);
    assertNoInjectedClash(sig.params);
    if (sig.returnType === undefined) throw new Error('define requires an explicit return type — it is verified against the body and becomes the tool\'s result contract, e.g. `weather(city: string): string { … }`. Use `: void` for a side-effect-only tool, or `: unknown` if the result is genuinely dynamic.');
    const clash = this.machine.tools.resolve(sig.name);
    if (clash !== null && !this.registered.has(sig.name)) {
      throw new Error(`A tool named "${sig.name}" already exists and wasn't defined here — choose another name.`);
    }
    // Type-check the body against the live tool types before registering — a strong signal the composition
    // is sound before it becomes a callable tool. Skipped when the ToolTypeIndex service is absent (e.g. the
    // browser — the function still compiles and runs), or when the caller opts out with noTypeCheck.
    const index = this.machine.ToolTypeIndex;
    let checked = false;
    if (index !== undefined && !noTypeCheck) {
      const report = await index.check(checkSnippet(sig));
      if (!report.ok) throw new Error(`type error(s) — fix and re-define, or pass noTypeCheck to bypass:\n${renderCheck(report)}`);
      // An index that cannot check says so, and a clean report from one proves nothing. The browser
      // registers such an index (for `dts()`), so trusting "an index was present" marked its definitions
      // verified when nothing had read them.
      checked = report.checked;
    }
    const doc: FunctionDoc = {
      id:      sig.name,
      version: Date.now().toString(),
      definition,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
      // Persisted, because a bypass that leaves no trace is indistinguishable from a pass: `noTypeCheck`
      // made a real failure go away without resolving it, and the errors surfaced only much later, when
      // an unrelated contract change made them impossible to ignore. Both bypass routes are recorded —
      // the explicit flag and the implicit "no checker here" — since the function is equally unverified.
      ...(checked ? {} : { definedUnchecked: true as const }),
    };
    await this.registerTool(recordOf(doc));   // compiles; throws on bad source before anything is persisted
    // No CAS: a define is an unconditional "this name now means this source", not a read-modify-write,
    // and the name is the whole identity. Only this one document is touched, so two concurrent defines
    // of different names can no longer lose each other.
    await this.store.set(doc.id, doc);
    this.registered.add(doc.id);
    return { name: sig.name, parameters: sig.params };
  }

  /** Re-run define's type-check over already-stored source, registering and persisting nothing: the same
   *  snippet through the same index, so a pass here means exactly what a pass at define time meant. What
   *  makes it worth re-running is that the tool types are LIVE — a tool that changes its contract can
   *  invalidate a function that was sound when it was defined, and nothing else would notice, because a
   *  defined function is only compiled (never re-checked) on reload. */
  async check(name?: string): Promise<CheckResult[]> {
    const index = this.machine.ToolTypeIndex;
    if (index === undefined) throw new Error('No type-checker is available here (e.g. the browser), so nothing can be checked.');

    let docs: FunctionDoc[];
    if (name === undefined) {
      ({ items: docs } = await this.store.query({ sort: [{ field: 'id', dir: 'asc' }], immutable: true }));
    } else {
      const doc = await this.store.get(name);
      if (doc === null) throw new Error(`No function named "${name}" was defined here.`);
      docs = [doc];
    }

    const results: CheckResult[] = [];
    for (const doc of docs) {
      let report: ToolCheckReport;
      // An unparseable head is this function's own failure, not the run's — reported as its row so a
      // sweep over every function still reports on the rest. It is not a tsc finding, so it gets the
      // same treatment as one rather than a shape of its own: one row type, countable the same way.
      try { report = await index.check(checkSnippet(parseSignature(doc.definition))); }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report = { ok: false, checked: false, total: 1, diagnostics: [{ label: 'PARSE', code: 0, message, rendered: message }] };
      }
      results.push({
        name: doc.id, ...report,
        ...(doc.definedUnchecked === true ? { definedUnchecked: true as const } : {}),
      });
    }
    return results;
  }

  async remove(name: string): Promise<boolean> {
    const doc = await this.store.get(name);
    if (doc === null) return false;
    await this.store.delete(name, doc.version);
    this.machine.tools.remove(name);
    this.registered.delete(name);
    return true;
  }

  removeAll(): void {
    for (const name of this.registered) this.machine.tools.remove(name);
    this.registered.clear();
  }

  private async registerTool(rec: FunctionRecord): Promise<void> {
    const sig        = parseSignature(rec.definition);
    const paramNames = sig.params.map(p => p.name);
    const fn: CompiledFn = await buildAsyncFn(this.machine.TypeScriptStripper, rec.definition, paramNames, this.machine.FunctionRunner);
    const machine = this.machine;
    const tool: Tool = {
      name:        rec.name,
      description: `${rec.description ? rec.description : (`${PLACEHOLDER_DESCRIPTION}\n\nSource:\n${rec.definition}`)}\n\nDefined via ${TOOL_NAME}.`,
      inputSchema: paramsSchema(sig.params),
      // A defined function has no augmentation source; it carries its own contract. Same shape as a
      // ToolContracts arm — the params object paired with the declared return type — so tool-types splices
      // it into the dts registry block (bare `ToolContract` rewritten to an inline import) and derives the
      // wire text from it, exactly as it does from a source tool's arms.
      toolContract: `ToolContract<${sig.returnType ?? 'unknown'}, ${paramsTypeText(sig.params)}>`,
      pluginName:  PLUGIN_NAME,
      executor: {
        execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const obj = (input ?? {}) as Record<string, unknown>;
          return runFunction(machine, ctx, fn, paramNames.map(p => obj[p]));
        },
      },
    };
    this.machine.tools.remove(rec.name);   // replace on re-define; no-op when absent
    this.machine.tools.register(tool);
  }
}

/**
 * Owns the defined packages: one document per package in `function-packages`, each registering a tool per
 * exported function. Like {@link FunctionStore} it holds no copy of the documents — only `owned`, the
 * tool names each package has put into the registry, which is what a redefinition or removal unregisters.
 */
class PackageStore {
  private readonly machine: MatbotMachine;
  private readonly store:   Store<PackageDoc>;
  private readonly owned = new Map<string, Set<string>>();

  constructor(machine: MatbotMachine, store: Store<PackageDoc>) {
    this.machine = machine;
    this.store   = store;
  }

  async reload(): Promise<void> {
    const { items } = await this.store.query({ immutable: true });
    const seen = new Set<string>();
    for (const doc of items) {
      try { await this.install(doc.id, parsePackage(doc.id, doc.definition), doc.definition); seen.add(doc.id); }
      catch (e) { console.warn(`[${PLUGIN_NAME}] skipping package "${doc.id}": ${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const name of [...this.owned.keys()]) if (!seen.has(name)) this.unregister(name);
  }

  async list(): Promise<PackageRecord[]> {
    const { items } = await this.store.query({ sort: [{ field: 'id', dir: 'asc' }], immutable: true });
    return items.map(doc => {
      let tools: string[] = [];
      try { tools = parsePackage(doc.id, doc.definition).exports.map(e => e.toolName); } catch { /* reported by check */ }
      return {
        name: doc.id, tools, definition: doc.definition,
        ...(doc.definedUnchecked === true ? { definedUnchecked: true as const } : {}),
      };
    });
  }

  /** The package that registered `toolName`, if one did — so a remove by tool name can say where it lives. */
  ownerOf(toolName: string): string | undefined {
    for (const [name, tools] of this.owned) if (tools.has(toolName)) return name;
    return undefined;
  }

  async define(name: string, definition: string, noTypeCheck = false): Promise<string[]> {
    const parsed = parsePackage(name, definition);
    // The whole module is the snippet, so a private helper's signature is checked against its callers too.
    const index = this.machine.ToolTypeIndex;
    let checked = false;
    if (index !== undefined && !noTypeCheck) {
      const report = await index.check(definition);
      if (!report.ok) throw new Error(`type error(s) — fix and re-define, or pass noTypeCheck to bypass:\n${renderCheck(report)}`);
      checked = report.checked;
    }
    await this.install(name, parsed, definition);
    const doc: PackageDoc = {
      id: name, version: Date.now().toString(), definition,
      ...(checked ? {} : { definedUnchecked: true as const }),
    };
    await this.store.set(doc.id, doc);
    return parsed.exports.map(e => e.toolName);
  }

  async check(name?: string): Promise<CheckResult[]> {
    const index = this.machine.ToolTypeIndex;
    if (index === undefined) throw new Error('No type-checker is available here (e.g. the browser), so nothing can be checked.');
    let docs: PackageDoc[];
    if (name === undefined) {
      ({ items: docs } = await this.store.query({ sort: [{ field: 'id', dir: 'asc' }], immutable: true }));
    } else {
      const doc = await this.store.get(name);
      if (doc === null) throw new Error(`No package named "${name}" was defined here.`);
      docs = [doc];
    }
    const results: CheckResult[] = [];
    for (const doc of docs) {
      let report: ToolCheckReport;
      try { parsePackage(doc.id, doc.definition); report = await index.check(doc.definition); }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report = { ok: false, checked: false, total: 1, diagnostics: [{ label: 'PARSE', code: 0, message, rendered: message }] };
      }
      results.push({
        name: doc.id, package: true, ...report,
        ...(doc.definedUnchecked === true ? { definedUnchecked: true as const } : {}),
      });
    }
    return results;
  }

  async remove(name: string): Promise<boolean> {
    const doc = await this.store.get(name);
    if (doc === null) return false;
    await this.store.delete(name, doc.version);
    this.unregister(name);
    return true;
  }

  removeAll(): void {
    for (const name of [...this.owned.keys()]) this.unregister(name);
  }

  private unregister(name: string): void {
    for (const tool of this.owned.get(name) ?? []) this.machine.tools.remove(tool);
    this.owned.delete(name);
  }

  /** Compile, then check every exported name, then swap the group in — so a failure at any step leaves
   *  the previous definition (or nothing) registered, never half of the new one. */
  private async install(name: string, parsed: ParsedPackage, definition: string): Promise<void> {
    const pkg  = await buildPackageFn(this.machine.TypeScriptStripper, definition, parsed, this.machine.FunctionRunner);
    const mine = this.owned.get(name) ?? new Set<string>();
    for (const e of parsed.exports) {
      if (this.machine.tools.resolve(e.toolName) !== null && !mine.has(e.toolName)) {
        throw new Error(`A tool named "${e.toolName}" already exists and wasn't defined by package "${name}" — rename the package or the function. Nothing was registered.`);
      }
    }
    const machine = this.machine;
    const next = new Set(parsed.exports.map(e => e.toolName));
    for (const old of mine) if (!next.has(old)) machine.tools.remove(old);
    for (const e of parsed.exports) {
      const fn = exportFn(pkg, e.name);
      const tool: Tool = {
        name:         e.toolName,
        description:  `${e.description ?? `${PLACEHOLDER_DESCRIPTION}\n\nSource:\n${e.source}`}\n\nExported by package "${name}", defined via ${TOOL_NAME}.`,
        inputSchema:  e.inputSchema,
        toolContract: e.toolContract,
        pluginName:   PLUGIN_NAME,
        executor: {
          execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
            return runFunction(machine, ctx, fn, e.param === undefined ? [] : [input ?? {}]);
          },
        },
      };
      machine.tools.remove(e.toolName);
      machine.tools.register(tool);
    }
    this.owned.set(name, next);
  }
}

const DESCRIPTION = `WHEN TO USE THIS — judge it by the SIZE and SHAPE of the work, not by the number of calls:

  1. A VERBOSE result you need a fraction of. A listing, a table, a file body, a search dump — where what
     you actually want is a count, a total, an aggregate, a summary, or two fields. Reading it through the
     conversation puts the whole thing in your context permanently in order to extract a line of it.
  2. LOOPS AND CONDITIONALS. The same call over n items, read-each-and-decide, retry-until-it-works,
     branch on what came back. A round per iteration, and every intermediate result kept for the session.

NOT FOR THIS — the pathological case, and the tempting one: wrapping a SINGLE tool call whose result you
are not reducing. If the body is one \`await tool.x(params)\` and a \`return\` of what came back, the lambda is
strictly WORSE than the call it wraps — the same result reaches you either way, and the wrapper cost you a
types call and a round to write it. There is no reason to wrap a single call whose result you are not going
to aggregate, filter, count, loop over, or feed into another call. Call the tool.

Authoring a lambda costs a call or two of its own (usually \`{ action: 'types' }\`, then the body), so two
direct calls with small results are also fine as they are. It wins decisively the moment bulk would pass
through the conversation to answer something small, or n grows.

  Piping it yourself:  workspace_action(list) → 200 names in context → workspace_action(read) → contents
                       in context → workspace_action(read) → … (a round each, all of it kept)
  One lambda:          (args: { prefix: string }): number { … list, read each, count matches … } → the number
  Pointless — do NOT: (args: { name: string }): string { return await tool.workspace_action({ action: 'read', name: args.name }); }
                       ↑ reduces nothing, so it is the same result for more work: call workspace_action.

Compose multiple tool calls — filter, count, reshape their results — without routing every intermediate result
back through the model. Compositions are expressed as TypeScript functions that orchestrate other tools in a single pass.

Inside a function, call any registered tool through the injected \`tool\` proxy:
\`const r = await tool.<tool_name>(params)\` runs that tool and resolves to its structured result (the same
value a direct call yields), inheriting this call's context. To run one call under a different context
(e.g. another model), use the \`toolInContext\` factory: \`await toolInContext({ provider: 'fast-model' }).<tool_name>(params)\`
— omitted fields are inherited. A tool name that doesn't exist is a compile error, so you can only call
tools that are actually registered. Every tool call MUST be awaited — the whole body runs as an async
function (so a recursive self-call must be awaited too). Return a JSON-serialisable value; that becomes
the result the model sees. Each tool call is echoed to stdout, so the run is observable.

THE INJECTED BINDINGS — three names are already in scope in every body. Use them directly; do NOT declare
them as parameters, do NOT redeclare them with const/let, and do NOT try to import or construct them (a
parameter of the same name is rejected, because it would shadow the injection):

  tool           the proxy above — \`await tool.<tool_name>(params)\`
  toolInContext  the factory above — \`await toolInContext({ provider }).<tool_name>(params)\`
  context        the call you are running under, exactly:
                   { callId: string; sessionId: string; provider?: string; workdir?: string; signal: AbortSignal;
                     progress: (pct: number, message?: string) => void }

\`context\` is how you answer "which session/turn am I in?" from inside a function — there is no tool that
reports it (\`session_action\` takes a \`sessionId\` as an explicit param; \`whoami\` returns the principal, not
the session). So the CURRENT session is \`context.sessionId\`:

  const s = await tool.session_action({ action: 'get', sessionId: context.sessionId });

Pass \`context.signal\` to any \`fetch\` you make so a long run stays cancellable. Note that \`context\`'s FIELDS
are informational: a nested \`tool.<name>()\` call ALREADY inherits this session, signal and provider, so only
pass its fields on where the callee takes them as explicit parameters (as \`session_action\` does above).

TELL THE USER WHAT YOU ARE DOING while the body runs: \`context.progress(pct, message)\` — \`pct\` 0-100,
\`message\` a short line of prose — draws a progress bar and caption against this call in the UI as it runs.
It is not part of your result and is never sent back to you, so it costs you no context; it simply goes away
when the call ends. Call it in any loop over n items, and between the stages of a multi-step body: a silent
function that takes a minute is indistinguishable, to the person waiting, from a hung one.

  const files = await tool.workspace_action({ action: 'list', prefix });
  for (const [i, f] of files.entries()) {
    context.progress((i / files.length) * 100, 'Reading ' + f.name);
    if ((await tool.workspace_action({ action: 'read', name: f.name })).includes('TODO')) hits++;
  }

Before composing, run \`{ action: 'types' }\` to fetch TypeScript declarations of what the available tools'
calls resolve to — write \`await tool.x(...)\` against those real return types instead of guessing shapes.

ACTIONS
  define — Persist a NAMED function and register it as a new tool of the same name. Parameters are
           derived from the signature and become the tool's inputs. You MUST declare an explicit return
           type — it is verified against the body and becomes the tool's result contract (use void for a
           side-effect-only tool). Pass an optional \`description\` to
           document the new tool (shown to the model). Survives restart. Re-defining the same name
           recompiles it. Never shadows a tool you didn't define here. Note: tools defined this way become
           visible on the *next turn*.
  lambda — Compile and run an ANONYMOUS one-argument function once, now, against \`params\`. Nothing is
           persisted or registered. This is the ordinary way to reduce a bulky or repetitive tool chain to
           just its answer — but NOT a wrapper for a single call (see NOT FOR THIS above). If the same
           chain is worth repeating later, define it instead. Type-checked against the live tool types before running (like define),
           so a bad composition is caught before it runs; pass \`noTypeCheck: true\` to bypass.
  package — Persist a PACKAGE: several tools plus private helpers they share, written as one TypeScript
           module. Pass \`name\` (the package name) and \`definition\` (the module source). Every \`export\`ed
           function becomes a tool named \`<package>__<function>\` — that exact name, with the double
           underscore, is how you, other functions and HTTP call it: \`await tool.<package>__<function>(params)\`.
           Everything NOT exported (helper functions, types, constants) is private to the package and is never
           a tool. Use this instead of defining a helper as a tool of its own. An exported function takes ONE
           object parameter (or none) and declares a return type, like a lambda, so calling it from inside the
           package (directly — \`await my_helper(args)\`, never through \`tool\`) looks the same as calling it
           from outside. A comment directly above an \`export\` becomes that tool's description. Type-checked
           as a whole before registering (\`noTypeCheck\` bypasses). Re-defining a package replaces the whole
           group — a function no longer exported stops being a tool — and \`remove { package }\` deletes it.

           A PACKAGE IS NOT A MODULE INSTANCE, and it has NO STATE. It looks like a Node module but does not
           behave like one: its whole top level is evaluated afresh on EVERY tool call, so nothing there
           persists between calls and nothing there runs once. Two calls to \`<package>__inc\` share nothing,
           and neither does a call through \`tool.<package>__x\` from inside the package. ONLY these may
           appear at the top level: \`function\`, \`async function\`, \`export function\`, \`export async
           function\`, \`const\` (for fixed values), \`interface\` and \`type\`. Anything else is REFUSED —
           including \`let\`/\`var\`, \`class\`, \`enum\`, \`declare\`, \`import\`, a bare statement (\`n++\`,
           \`await tool.x(...)\`) and a top-level \`await\` (\`const cfg = await ...\`).
           WHAT A PACKAGE IS FOR: not polluting the global tool scope. Every tool is one entry in a single,
           shared list that the model chooses from; a helper registered as a tool competes with the tools that
           use it. A package lets related tools share private helpers without adding them to that list — and
           that is ALL it does. It is NOT a substitute for a plugin. If what you are building needs to REMEMBER
           anything between calls — a counter, a cache, a connection, one-time setup — or needs hooks,
           services or background work, write a matbot PLUGIN, which has all of those capabilities.
  check  — Re-run define's type-check over a function you already defined, without running or re-registering
           it. Pass \`name\` for one function or \`package\` for one package, or omit both to check everything. Use this after anything that
           could move a contract a function was written against — a tool changing its parameters or result,
           a plugin loading or unloading — since a defined function is compiled but NOT re-checked on
           reload, so it keeps working until the moment it doesn't. Returns a row per function: \`total\` is
           every finding, \`diagnostics\` the detailed ones (each with a \`rendered\` block to read and a
           \`label\` such as \`TS2339\` or \`CAST-GATE\` to group on), and \`omitted\` the tally of any the
           detail cap hid. Fix a failure by re-defining that function. A row also carries
           \`definedUnchecked: true\` if that function was never type-checked when it was defined.
           READ \`ok\` TOGETHER WITH \`checked\`, on the result and on each row: \`checked: false\` means
           no type-checker could run here, so \`ok: true\` says only that nothing was examined.
  list   — Show the functions and packages you've defined, with their source. \`definedUnchecked: true\` marks one that
           was registered without a type-check (it was defined with \`noTypeCheck\`, or no checker was
           available) — run \`check\` on it, since a bypass hides errors that are still there.
  types  — Return TypeScript declarations (a .d.ts) of what the available tools' calls resolve to, so you
           can compose against real return types. Node only; \`available: false\` with an empty dts where
           type info can't be derived (e.g. the browser) — fall back to inferring shapes and testing.
  remove — Delete a defined function (\`name\`) and unregister its tool, or a whole package (\`package\`)
           and every tool it exports.

Functions use method-shorthand syntax — NOT arrow functions:

  define (definition):
    count_plugins(check: string): string {
      const p = await tool.plugin({ action: 'list' });
      const n = p.loaded.filter(pl => pl.name.includes(check)).length;
      return n + ' plugins match "' + check + '"';
    }
  → registers tool "count_plugins" taking { check: string }.

  define (definition) using the injected \`context\` — no sessionId parameter needed, it knows where it is:
    turn_count(): number {
      const s = await tool.session_action({ action: 'get', sessionId: context.sessionId });
      return s.messages.length;
    }
  → registers tool "turn_count" taking {}.

  lambda (definition + params):
    definition: (args: { names: string[] }): string[] { return args.names.map(n => n.toUpperCase()); }
    params:     { "names": ["a", "b"] }

  package (name + definition):
    name:       Presence
    definition:
      interface Report { home: boolean; room?: string }
      async function report(): Promise<Report> { … one private helper, shared below … }
      // Whether Mat is at home, in one word.
      export async function where(args: {}): Promise<string> { return (await report()).home ? 'home' : 'out'; }
      // The room Mat was last seen in.
      export async function room(args: {}): Promise<string> { return (await report()).room ?? 'unknown'; }
  → registers tools "Presence__where" and "Presence__room"; \`report\` is not a tool.`;

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action:     { type: 'string', enum: ['define', 'lambda', 'package', 'check', 'list', 'types', 'remove'], description: 'define: persist a named function as a tool. lambda: run an anonymous function once. package: persist a TypeScript module whose exported functions become tools <package>__<function>. check: re-type-check already-defined functions/packages against the current tool types. types: get TypeScript declarations of tool return types. list / remove: manage defined functions and packages.' },
    definition:  { type: 'string', description: 'define/lambda: the function source (method-shorthand TypeScript, no arrow). package: the module source — exported functions become tools, the rest is private. Stateless: only declarations at the top level (no let/var, statements or top-level await).' },
    package:     { type: 'string', description: 'remove / check (optional): the package to delete or check.' },
    description: { type: 'string', description: 'define only (optional): Describe the intent of the function from the context used to create it. Include a clause describing the use-cases for the function tool. Becomes the defined tool\'s description, and therefore it is important to make the description both specific in terms of intent and use-cases. Do not describe the mechanism or execution as this is already clear from the code.' },
    params:      { type: 'object', description: 'lambda only: the single argument object passed to the function.' },
    noTypeCheck: { type: 'boolean', description: 'define/lambda (optional, default false): skip the TypeScript type-check of the body against the live tool types. The check is a strong signal the composition is sound before it is registered/run — leave it on unless you must bypass a spurious error (e.g. composing a tool whose result type is `unknown`). A bypassed error does not go away: it is still there, and will surface later when something unrelated moves, so a function defined this way is marked `definedUnchecked` in `list` and `check` and should be checked again once the obstacle is gone. No effect where no type-checker is available (e.g. the browser) — a definition made there is marked the same way, being equally unverified.' },
    name:       { type: 'string', description: 'package: the package name (an identifier, no "__"). remove: the defined function/tool name to delete. check (optional): the one function to check.' },
  },
};

/**
 * Always-injected system-prompt guidance: prefer ONE lambda over a round-per-call chain when a turn's
 * work is multi-stage. It belongs in the system prompt rather than in this tool's own description
 * because it is advice about *when to reach for the tool at all* — a model that never considers
 * `tool_function` never reads its description, and by the time it does the round-per-call turn is
 * already under way. Constant text, so it is a stable cache prefix (see the `contribute` hook note in
 * CLAUDE.md) rather than something rebuilt per turn.
 */
const MULTI_STAGE_ADVICE =
  "## tool_function { action: 'lambda' }\n\n" +
  'Lambda functions allow you to run Javascript directly, which is often more efficient than shelling python ' +
  'or bash, and works even if you have no shell tools available. You can call tools from lambda functions. ' +
  'The test for lambda functions is whether you are REDUCING a result: (a) a tool ' +
  'whose result is VERBOSE and you need a fraction of it — a count, a total, an aggregate, a summary, a ' +
  'couple of fields; or (b) a LOOP or a CONDITIONAL — the same call over n items, read-each-and-decide, ' +
  'retry-until, branch on what came back. There a lambda does the whole thing in one call and returns only ' +
  'the answer, and the listings, rows and file bodies it read on the way are never sent to you. Run ' +
  "`{ action: 'types' }` first and write `await tool.x(...)` against the real result types. " +
  'DO NOT wrap a single tool call whose result you are not reducing. A lambda whose body is one ' +
  '`await tool.x(params)` and a `return` of what came back is strictly WORSE than calling that tool: the ' +
  'same result reaches you either way, and the wrapper cost you a types call and a round to write it. If ' +
  'the body would not filter, count, aggregate, loop, or feed the result into a second call, it has ' +
  'nothing to do — call the tool directly.';

const errorEvent = (message: string): ToolEvent => ({ type: 'error', message });

function functionTool(machine: MatbotMachine, store: FunctionStore, packages: PackageStore): Tool<ToolResultOf<'tool_function'>> {
  return {
    name:        TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const act = (input ?? {}) as ToolFunctionAction;
        switch (act.action) {
          case 'define': {
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('define requires a "definition" (a named function).'); return; }
            try {
              const { name, parameters } = await store.define(act.definition, act.description, act.noTypeCheck === true);
              const params = parameters.map(p => p.name).join(', ');
              const note = act.noTypeCheck === true ? ' (type-check skipped)' : '';
              yield { type: 'result', value: { message: `Defined tool "${name}"${params ? ` (${params})` : ''}.${note} Call it directly to run.`, tool: name, parameters } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'lambda': {
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('lambda requires a "definition" (an anonymous function).'); return; }
            let fn: CompiledFn;
            try { fn = await buildAsyncFn(machine.TypeScriptStripper, act.definition, ['args'], machine.FunctionRunner); }
            catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); return; }
            // The lambda calling convention is ONE argument (the params object). Gate it structurally:
            // the typecheck grades the function against its OWN signature, not the convention, so a
            // multi-param head would typecheck and then silently run as (paramsObject, undefined, …).
            let sig: ParsedSignature | undefined;
            try { sig = parseSignature(act.definition); } catch { /* head unparseable — gates skipped */ }
            if (sig !== undefined && sig.params.length > 1) {
              yield errorEvent('lambda takes exactly ONE argument — the `params` object. Declare a single object parameter and read fields from it, e.g. (args: { a: number; b: number }): number { return args.a + args.b; }');
              return;
            }
            if (sig !== undefined) {
              try { assertNoInjectedClash(sig.params); }
              catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); return; }
            }
            // Type-check the body against the live tool types before running (node only; opt out with
            // noTypeCheck). Syntax was already gated by buildAsyncFn above.
            const index = machine.ToolTypeIndex;
            if (index !== undefined && act.noTypeCheck !== true && sig !== undefined) {
              const report = await index.check(checkSnippet(sig));
              if (!report.ok) { yield errorEvent(`type error(s) — fix and re-run, or pass noTypeCheck to bypass:\n${renderCheck(report)}`); return; }
            }
            yield* runFunction(machine, ctx, fn, [act.params ?? {}]);
            return;
          }
          case 'package': {
            if (typeof act.name !== 'string' || act.name === '') { yield errorEvent('package requires a "name" (the package name).'); return; }
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('package requires a "definition" (the module source).'); return; }
            try {
              const tools = await packages.define(act.name, act.definition, act.noTypeCheck === true);
              const note = act.noTypeCheck === true ? ' (type-check skipped)' : '';
              yield { type: 'result', value: { message: `Defined package "${act.name}" exporting ${tools.map(t => `"${t}"`).join(', ')}.${note} Call them by those names.`, package: act.name, tools } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'check': {
            if (act.name !== undefined && (typeof act.name !== 'string' || act.name === '')) {
              yield errorEvent('check: "name" must be the name of a defined function — omit it to check every one.');
              return;
            }
            try {
              const results = act.package !== undefined ? await packages.check(act.package)
                : act.name !== undefined ? await store.check(act.name)
                : [...await store.check(), ...await packages.check()];
              // `ok` is qualified by `checked` here exactly as it is on a row: where no type-checker can
              // run (the browser registers an index that supplies types but checks nothing), every row
              // comes back clean and a bare `ok: true` would report success for work nothing did.
              yield { type: 'result', value: {
                ok:      results.every(r => r.ok),
                checked: results.every(r => r.checked),
                results,
              } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'list':
            yield { type: 'result', value: { functions: await store.list(), packages: await packages.list() } };
            return;
          case 'types': {
            const index = machine.ToolTypeIndex;
            if (index === undefined) {
              yield { type: 'result', value: { available: false, dts: '' } };
              return;
            }
            yield { type: 'result', value: { available: true, dts: await index.dts() } };
            return;
          }
          case 'remove': {
            if (typeof act.package === 'string' && act.package !== '') {
              const ok = await packages.remove(act.package);
              yield { type: 'result', value: { message: ok ? `Removed package "${act.package}" and its tools.` : `No package named "${act.package}" was defined here.` } };
              return;
            }
            if (typeof act.name !== 'string' || act.name === '') { yield errorEvent('remove requires a "name" (a function) or a "package".'); return; }
            const ok = await store.remove(act.name);
            const owner = ok ? undefined : packages.ownerOf(act.name);
            // A package is removed as a group, so one export cannot be removed from under its siblings.
            const miss = owner !== undefined
              ? `"${act.name}" is exported by package "${owner}" — remove { package: "${owner}" } removes the group, or re-define the package without it.`
              : `No function named "${act.name}" was defined here.`;
            yield { type: 'result', value: { message: ok ? `Removed "${act.name}".` : miss } };
            return;
          }
          default:
            yield errorEvent(`Unknown ${TOOL_NAME} action "${String((act as { action?: unknown }).action)}".`);
        }
      },
    },
  };
}

export function createFunctionToolsPlugin(): MatbotPluginSpec {
  let store:     FunctionStore | undefined;
  let packages:  PackageStore | undefined;
  let lifecycle: AbortController | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Author and run TypeScript functions that compose registered tools (`tool_function`: define/lambda/check/list/remove).' },

    async setup(services) {
      lifecycle = new AbortController();
      const docs = notifyingStore(
        services.createStore<FunctionDoc>(NAMESPACE), services.Notifier, NAMESPACE, 'function',
      );
      const fns = new FunctionStore(services, docs);
      store = fns;
      const pkgs = new PackageStore(services, notifyingStore(
        services.createStore<PackageDoc>(PACKAGE_NAMESPACE), services.Notifier, PACKAGE_NAMESPACE, 'function-package',
      ));
      packages = pkgs;
      await fns.reload();
      await pkgs.reload();
      // The registered tools are state derived from the store at setup time, so they must be rebuilt
      // when a deferred StorageBackend swap lands on a different `functions` set. No `replay` — the
      // boot load is above; this reacts only to future swaps.
      services.mounted.observe({ key: 'StorageBackend', signal: lifecycle.signal }, () => void fns.reload().then(() => pkgs.reload()));
      services.tools.register(functionTool(services, fns, pkgs));
      services.systemContext.register(() => MULTI_STAGE_ADVICE);
    },

    async teardown() { lifecycle?.abort(); store?.removeAll(); packages?.removeAll(); },
  };
}

export const plugin: MatbotPluginSpec = createFunctionToolsPlugin();
