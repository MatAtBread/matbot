import { PLUGIN_API_VERSION, notifyingStore, renderToolCheck as renderCheck } from '@matatbread/matbot-plugin-api';
import type {
  JSONSchema, MatbotMachine, MatbotPluginSpec, MessageContent, Session, Store,
  Tool, ToolContext, ToolEvent, ToolContract, ToolResultOf, ToolCheckReport,
} from '@matatbread/matbot-plugin-api';
import { buildAsyncFn, buildBodyFn, runFunction, INJECTED, EXECUTE_SUBJECT, type CompiledFn } from './compile.js';
import { parseSignature, paramsSchema, unwrapPromise, type ParsedParam, type ParsedSignature } from './signature.js';
import { parsePackage, buildPackageFn, exportFn, type ParsedPackage } from './package.js';
import { MARKER_CREATOR, sessionFunctions, turnContracts, shadowMessage, type SessionFunctionMarker, type SessionFunctionRecord } from './session.js';

const TOOL_NAME         = 'tool_function';
const PLUGIN_NAME       = 'function-tools';
const NAMESPACE         = 'functions';
const PACKAGE_NAMESPACE = 'function-packages';

interface FunctionRecord { name: string; definition: string; description?: string; definedUnchecked?: true }

/** One function's row in a `check` sweep: the service's report, plus who it is about. `diagnostics`
 *  carries each finding's own `rendered` text, so a reader displays that and counts on `total`. */
interface CheckResult extends ToolCheckReport { name: string; package?: true; session?: true; definedUnchecked?: true }

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
 *  body; without one (a session function may omit it) TS infers it, still checking the body and its `tool` calls. */
function checkSnippet(sig: ParsedSignature): string {
  if (sig.returnType === undefined) return `async function __fn(${sig.paramsText}) ${sig.body}`;
  const ret = /^Promise\s*</.test(sig.returnType) ? sig.returnType : `Promise<${sig.returnType}>`;
  return `async function __fn(${sig.paramsText}): ${ret} ${sig.body}`;
}

type DefinedSignature = ParsedSignature & { name: string; returnType: string };

/** What every `define` requires of its source, whichever scope it is going to. */
function parseDefinition(definition: string): DefinedSignature {
  const sig = parseSignature(definition);
  if (sig.name === undefined) throw new Error('define requires a NAMED function, e.g. `weather(city: string): string { … }`.');
  if (sig.name === TOOL_NAME) throw new Error(`"${TOOL_NAME}" is reserved.`);
  assertNoInjectedClash(sig.params);
  if (sig.returnType === undefined) throw new Error('define requires an explicit return type — it is verified against the body and becomes the tool\'s result contract, e.g. `weather(city: string): string { … }`. Use `: void` for a side-effect-only tool, or `: unknown` if the result is genuinely dynamic.');
  return { ...sig, name: sig.name, returnType: sig.returnType };
}

/**
 * A defined function's contract, in the same shape as a `ToolContracts` arm.
 *
 * `unwrapPromise`, because {@link checkSnippet} ADDS a `Promise<…>` to verify the body against, so both
 * `f(): T` and `async f(): Promise<T>` describe one tool — and the wrapper prepends `async` anyway, which
 * makes the second the form a TypeScript author reaches for first. Spliced verbatim, the two spellings
 * disagreed on the way out: the declared `Promise<T>` became the RESULT, so `tool.f()` resolved to
 * `Promise<T>`. `await` hid it (it unwraps recursively) and `.then(r => r.x)` did not, and tsc's own
 * "Did you forget to use 'await'?" then pointed at the one thing that was already right.
 */
const contractOf = (sig: ParsedSignature): string =>
  `ToolContract<${sig.returnType !== undefined ? unwrapPromise(sig.returnType) : 'unknown'}, ${paramsTypeText(sig.params)}>`;

/** A global definition's failed type-check. A global function calling one of this session's functions
 *  fails the check (its check never sees them) and the bare diagnostic does not say why — it would run
 *  here and fail in every other session — so the names it trips on are spelled out. */
function globalTypeError(report: ToolCheckReport, sessionNames: Iterable<string>): string {
  const rendered = report.diagnostics.map(d => d.rendered).join('\n');
  const tripped  = [...sessionNames].filter(n => rendered.includes(`'${n}'`));
  const hint = tripped.length === 0 ? '' : `\n\nHINT: ${tripped.map(n => `"${n}"`).join(', ')} ${tripped.length === 1 ? 'is a session function' : 'are session functions'}, which only this conversation can call — a global function calling ${tripped.length === 1 ? 'it' : 'them'} would fail everywhere else. Define ${tripped.length === 1 ? 'it' : 'them'} with scope: 'global' first.`;
  return `type error(s) — fix and re-define, or pass noTypeCheck to bypass:\n${renderCheck(report)}${hint}`;
}

/** The tool a defined function becomes — the same for a registered one and a session one, bar `origin`
 *  (where its description says it came from) and `check` (the input gate a session one needs, having no
 *  registry entry for a validator to find it by). */
function definedTool(
  machine: MatbotMachine, rec: FunctionRecord, sig: ParsedSignature, fn: CompiledFn,
  origin: string, extra?: { wire?: true; check?: (input: Record<string, unknown>) => string | undefined },
): Tool {
  const paramNames = sig.params.map(p => p.name);
  const contract   = contractOf(sig);
  const base = rec.description ? rec.description : `${PLACEHOLDER_DESCRIPTION}\n\nSource:\n${rec.definition}`;
  // A registered tool's params/result text is folded in by the host at dispatch; a session one never
  // reaches that fold, so it carries the same two blocks itself.
  const wire = extra?.wire === true
    ? `\n\nTypeScript params:\n\`\`\`\n${paramsTypeText(sig.params)}\n\`\`\`\n\nTypeScript result:\n\`\`\`\n${sig.returnType !== undefined ? unwrapPromise(sig.returnType) : 'unknown'}\n\`\`\``
    : '';
  return {
    name:        rec.name,
    description: `${base}\n\n${origin}${wire}`,
    inputSchema: paramsSchema(sig.params),
    // A defined function has no augmentation source; it carries its own contract. Same shape as a
    // ToolContracts arm — the params object paired with the declared return type — so tool-types splices
    // it into the dts registry block (bare `ToolContract` rewritten to an inline import) and derives the
    // wire text from it, exactly as it does from a source tool's arms.
    toolContract: contract,
    pluginName:  PLUGIN_NAME,
    executor: {
      execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const obj = (input ?? {}) as Record<string, unknown>;
        const bad = extra?.check?.(obj);
        if (bad !== undefined) return (async function* () { yield { type: 'error', message: bad } satisfies ToolEvent; })();
        return runFunction(machine, ctx, fn, paramNames.map(p => obj[p]), { tool: rec.name, source: rec.definition });
      },
    },
  };
}

/** The input gate for a session function: the two shapes of wrong call a model actually makes — a
 *  misspelt name (dropped silently, it reads as "not given") and a missing one. Types are the checker's. */
function paramsGate(name: string, params: readonly ParsedParam[]): (input: Record<string, unknown>) => string | undefined {
  const known = new Set(params.map(p => p.name));
  return input => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return `Invalid input for tool "${name}": expected an object of named parameters.`;
    const errs = [
      ...Object.keys(input).filter(k => !known.has(k)).map(k => `unknown property "${k}"`),
      ...params.filter(p => !p.optional && input[p.name] === undefined).map(p => `missing required property "${p.name}"`),
    ];
    return errs.length === 0 ? undefined : `Invalid input for tool "${name}": ${errs.join('; ')}. It takes ${paramsTypeText([...params])}.`;
  };
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    tool_function:
      | ToolContract<{ message: string; tool: string; parameters: ParsedParam[] }, { action: 'define'; definition: string; description?: string; scope?: 'global' | 'session'; noTypeCheck?: boolean }>
      | ToolContract<unknown,                                                      { action: 'execute'; definition: string; noTypeCheck?: boolean }>
      | ToolContract<{ message: string; package: string; tools: string[] },         { action: 'package'; name: string; definition: string; noTypeCheck?: boolean }>
      | ToolContract<{ ok: boolean; checked: boolean; results: CheckResult[] },    { action: 'check';  name?: string; package?: string }>
      | ToolContract<{ functions: FunctionRecord[]; packages: PackageRecord[]; sessionFunctions: SessionFunctionRecord[] }, { action: 'list' }>
      | ToolContract<{ available: boolean; dts: string },                         { action: 'types'  }>
      | ToolContract<{ message: string },                                         { action: 'remove'; name: string } | { action: 'remove'; package: string }>;
  }
}

type ToolFunctionAction =
  | { action: 'define'; definition: string; description?: string; scope?: 'global' | 'session'; noTypeCheck?: boolean }
  | { action: 'execute'; definition: string; noTypeCheck?: boolean }
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

  async has(name: string): Promise<boolean> {
    return await this.store.get(name) !== null;
  }

  /** `sessionNames`: the calling session's own functions, named in the hint if the check trips on one. */
  async define(definition: string, description?: string, noTypeCheck = false, sessionNames: Iterable<string> = []): Promise<{ name: string; parameters: ParsedParam[] }> {
    const sig = parseDefinition(definition);
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
      if (!report.ok) throw new Error(globalTypeError(report, sessionNames));
      // An index that cannot check says so, and a clean report from one proves nothing. The browser
      // registers such an index (for `dts()`), so trusting "an index was present" marked its definitions
      // verified when nothing had read them.
      checked = report.checked;
    }
    const doc: FunctionDoc = {
      id:      sig.name,
      version: crypto.randomUUID(),
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
    const sig = parseSignature(rec.definition);
    const fn  = await buildAsyncFn(this.machine, rec.definition, sig.params.map(p => p.name));
    const tool = definedTool(this.machine, rec, sig, fn, `Defined via ${TOOL_NAME}.`);
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

  async define(name: string, definition: string, noTypeCheck = false, sessionNames: Iterable<string> = []): Promise<string[]> {
    const parsed = parsePackage(name, definition);
    // The whole module is the snippet, so a private helper's signature is checked against its callers too.
    const index = this.machine.ToolTypeIndex;
    let checked = false;
    if (index !== undefined && !noTypeCheck) {
      const report = await index.check(definition);
      if (!report.ok) throw new Error(globalTypeError(report, sessionNames));
      checked = report.checked;
    }
    await this.install(name, parsed, definition);
    const doc: PackageDoc = {
      id: name, version: crypto.randomUUID(), definition,
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
    const pkg  = await buildPackageFn(this.machine, definition, parsed);
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
            return runFunction(machine, ctx, fn, e.param === undefined ? [] : [input ?? {}], { tool: e.toolName, source: e.source });
          },
        },
      };
      machine.tools.remove(e.toolName);
      machine.tools.register(tool);
    }
    this.owned.set(name, next);
  }
}

/** A `check` row that is not a tsc finding, shaped like one so a reader counts every row the same way. */
const findingRow = (label: string, message: string): ToolCheckReport =>
  ({ ok: false, checked: false, total: 1, diagnostics: [{ label, code: 0, message, rendered: message }] });

const BUILD_CACHE_LIMIT = 256;

/**
 * The session-scoped functions. The session holds them ({@link SessionFunctionMarker}), so what this keeps
 * is only a cache of the tools built from them: the runner asks for a session's tools at every round of
 * every turn, and recompiling the same source each time is the one cost worth avoiding. Keyed by the
 * record, so two sessions with the same source share a build and a re-definition is a new key. Bounded,
 * oldest out — a long-lived process sees every session's history pass through here.
 */
class SessionFunctions {
  private readonly machine: MatbotMachine;
  private readonly built  = new Map<string, Promise<Tool | Error>>();
  private readonly warned = new Set<string>();

  constructor(machine: MatbotMachine) {
    this.machine = machine;
  }

  /** The tools to offer `session` this round — the source the screen hook hands the runner. */
  async tools(session: Session): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const rec of sessionFunctions(session).values()) {
      // A global tool has since taken the name. The screen hook tells the model; offering it here would
      // only have the runner drop it.
      if (this.machine.tools.resolve(rec.name) !== null) continue;
      const tool = await this.build(rec);
      if (!(tool instanceof Error)) { out.push(tool); continue; }
      const key = `${rec.name}\0${rec.definition}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[${PLUGIN_NAME}] session function "${rec.name}" (session ${session.id}) is not offered: ${tool.message}`);
      }
    }
    return out;
  }

  /**
   * Verify a definition and return the marker recording it. Nothing is stored: the marker IS the
   * definition, and the runner puts it in the session at the end of this round, which is what makes it
   * callable from the next. Checked against this turn's tools — including the session's other functions,
   * so one may call another — plus itself, so it may recurse.
   */
  async define(ctx: ToolContext, definition: string, description?: string, noTypeCheck = false): Promise<{ marker: SessionFunctionMarker; name: string; parameters: ParsedParam[] }> {
    const sig = parseDefinition(definition);
    if (this.machine.tools.resolve(sig.name) !== null) throw new Error(shadowMessage(sig.name));
    const index = this.machine.ToolTypeIndex;
    let checked = false;
    if (index !== undefined && !noTypeCheck) {
      const report = await index.check(checkSnippet(sig) + turnContracts(ctx.turnTools, { name: sig.name, contract: contractOf(sig) }));
      if (!report.ok) throw new Error(`type error(s) — fix and re-define, or pass noTypeCheck to bypass:\n${renderCheck(report)}`);
      checked = report.checked;
    }
    const rec: SessionFunctionRecord = {
      name: sig.name, definition,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
      ...(checked ? {} : { definedUnchecked: true as const }),
    };
    const built = await this.build(rec);   // compiles: a bad source fails here, before any marker exists
    if (built instanceof Error) throw built;
    return { marker: { op: 'define', ...rec }, name: sig.name, parameters: sig.params };
  }

  /** define's check, re-run against the tools as they stand now — which is how a function left calling
   *  one a `split` took away, or one a global tool has since shadowed, is found before it is called. */
  async check(ctx: ToolContext, recs: Iterable<SessionFunctionRecord>): Promise<CheckResult[]> {
    const index = this.machine.ToolTypeIndex;
    if (index === undefined) throw new Error('No type-checker is available here (e.g. the browser), so nothing can be checked.');
    const results: CheckResult[] = [];
    for (const rec of recs) {
      let report: ToolCheckReport;
      if (this.machine.tools.resolve(rec.name) !== null) report = findingRow('SHADOWED', shadowMessage(rec.name));
      else {
        try {
          const sig = parseSignature(rec.definition);
          report = await index.check(checkSnippet(sig) + turnContracts(ctx.turnTools, { name: rec.name, contract: contractOf(sig) }));
        } catch (e) { report = findingRow('PARSE', e instanceof Error ? e.message : String(e)); }
      }
      results.push({
        name: rec.name, session: true, ...report,
        ...(rec.definedUnchecked === true ? { definedUnchecked: true as const } : {}),
      });
    }
    return results;
  }

  private build(rec: SessionFunctionRecord): Promise<Tool | Error> {
    const key = JSON.stringify([rec.name, rec.definition, rec.description ?? null]);
    const hit = this.built.get(key);
    if (hit !== undefined) return hit;
    const made = (async (): Promise<Tool | Error> => {
      try {
        const sig = parseSignature(rec.definition);
        const fn  = await buildAsyncFn(this.machine, rec.definition, sig.params.map(p => p.name));
        return definedTool(this.machine, rec, sig, fn, `Defined via ${TOOL_NAME} for this conversation only.`,
          { wire: true, check: paramsGate(rec.name, sig.params) });
      } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
    })();
    this.built.set(key, made);
    if (this.built.size > BUILD_CACHE_LIMIT) {
      const oldest = this.built.keys().next().value;
      if (oldest !== undefined) this.built.delete(oldest);
    }
    return made;
  }
}

const sessionMarker = (data: SessionFunctionMarker): ToolEvent => ({ type: 'marker', creator: MARKER_CREATOR, data });

const DESCRIPTION = `Compile and run TypeScript in one pass across the registered tools. Inside a body you call them as
\`await tool.x(params)\`, then filter, count, aggregate or loop, and return only the answer — so the
listings, rows and file bodies it read on the way never enter the conversation.

An \`execute\` runs once, now, and saves nothing. A \`define\` saves the function as a tool you can call by
name. A \`package\` saves several tools that share private helpers. You are not limited to the tools: on
node a body can reach the platform itself (see NODE BUILTINS), and it is often an efficient substitute
for a shell one-liner.

WHEN TO USE IT — judge by the SIZE and SHAPE of the work, not the number of calls:
  1. A VERBOSE result you need a fraction of — a count, a total, an aggregate, a summary, two fields.
  2. A LOOP or a CONDITIONAL — the same call over n items, read-each-and-decide, retry-until, branch.
  3. A multi-step chain that would otherwise cost a round per step, with no LLM turn between the steps.
NOT FOR THIS — wrapping a SINGLE tool call whose result you are not reducing. A body that is one
\`await tool.x(params)\` and a \`return\` of what came back is strictly WORSE than the call it wraps: the same
result reaches you either way, and the wrapper cost you a round to write it. If the body would not filter,
count, aggregate, loop, or feed its result into a second call, call the tool directly.

ACTIONS
  action   required          optional            what it makes
  execute  definition        noTypeCheck         one run now of the BODY between braces; nothing is saved.
  define   definition        description, scope  a NAMED tool of that name.
  package  name, definition  noTypeCheck         one tool per \`export\`, named <name>__<function>.
  check    —                 name, package       a report; registers and persists nothing.
  list     —                 —                   the functions, packages and session functions.
  types    —                 —                   the d.ts a body is graded against.
  remove   name, or package  —                   a defined function, or a whole package and its tools.
\`noTypeCheck\` is accepted by execute, define and package: it skips the type-check, and a persisted
definition is then recorded as \`definedUnchecked\`.

HOW THE PARAMETERS RELATE
  definition  the BODY for execute; a FUNCTION for define; MODULE source for package.
  scope       define only — 'global' (default) or 'session'. A package is always global.
  name        the function or package to act on, for remove / check; the PACKAGE name for package. NOT
              for define — a defined tool takes its name from its own source.
  package     a selector for check and remove, NOT the define action (that is action: 'package').
  There are no other parameters: an execute takes no arguments, so it declares no parameters, and a
define takes its inputs from the parameter list written into its own signature.

WHAT A BODY IS
A bare BODY — statements, not a module and not a function. It is compile-checked against the live tool
types before it runs (node; skip with \`noTypeCheck\`), and it runs as an async function, so \`await\` works
throughout. There is no \`this\`, and nothing to export.
Three names are injected — use them directly, and do NOT declare them as parameters or \`const\`/\`let\`
(a parameter of the same name is rejected, because it would shadow the injection):
  tool           \`await tool.<tool_name>(params)\` — any registered tool, inheriting this call's context.
  toolInContext  \`await toolInContext({ provider }).<tool_name>(params)\` — one call under an override.
  context        \`{ callId, sessionId, provider?, workdir?, signal, progress(pct, message?) }\` — the call
                 you are running under. \`context.sessionId\` is THIS conversation; pass \`context.signal\`
                 to any \`fetch\` so a long run stays cancellable; \`context.progress\` draws a progress bar
                 for the person waiting, costs you no context and is never sent back to you.
Every \`tool\` call MUST be awaited — the whole body runs as an async function, so a nested call, including
a function calling itself, must be awaited too. Return a JSON-serialisable value; that becomes the result the model sees. Each tool
call is echoed to stdout, so the run is observable.

MODULES (node only). A body may reach the platform through a dynamic import —
\`const fs = await import('node:fs/promises')\` — and each import needs permission at the call: the user is
asked, naming your function and the module, the first time. Ask for the narrowest thing that does the job.
The \`types\` action states what is reachable here; a module outside that does not type-check, so do not
guess, and do not reach for \`noTypeCheck\` to get past it. There is no \`require\`, \`module\`,
\`exports\`, \`__dirname\`, \`__filename\` or \`import.meta\` — a body is not a module — and no \`process\`,
\`Buffer\` or \`globalThis\`. Each is rejected rather than left to fail at the first call.

SCOPE — WHO ASKED FOR THE FUNCTION DECIDES IT
  'global' (default) — the user asked for a tool ("make me a tool that calculates Fibonacci numbers"). It
     is saved, survives restart, and is a tool in every conversation, over HTTP and to the tool presenter.
  'session' — you want a function of your own while working something out: one you will call again, or a
     helper two of them share. Only THIS conversation has it — call it directly from your next round,
     or as \`await tool.<name>(…)\` from your other functions, type-checked like any tool. It is stored in
     the conversation itself, so it survives a restart and follows the conversation through a fork, cut or
     compact.
A global tool in every conversation's list is a cost to every conversation, so do not make one the user did
not ask for. A global function cannot call a session one — it would fail in every other conversation. To
promote a session function, define it again with scope 'global' (it replaces the session one).

PACKAGES
Several tools plus the private helpers they share, as one TypeScript module. Every \`export\` becomes a tool
named \`<package>__<function>\`, called as \`await tool.<package>__<function>(params)\`. Everything not
exported (helpers, types, constants) stays private and is never registered. Use a package instead of
defining a helper as a tool of its own: every tool is one entry in one shared list the model chooses from,
so a helper registered as a tool competes with the tools that use it.
A PACKAGE IS NOT A MODULE INSTANCE, and it has NO STATE. Its whole top level is evaluated afresh on EVERY
call, so nothing there persists between calls and nothing there runs once; two calls to \`<package>__inc\`
share nothing. ONLY these may appear at the top level: \`function\`, \`async function\`, \`export function\`,
\`export async function\`, \`const\` (for fixed values), \`interface\` and \`type\`. Anything else is REFUSED —
including \`let\`/\`var\`, \`class\`, \`enum\`, \`declare\`, a top-level \`import\` statement (a dynamic
\`await import('node:…')\` inside a function body is fine), a bare statement (\`n++\`, \`await tool.x(...)\`)
and a top-level \`await\` (\`const cfg = await ...\`). Re-defining a package replaces the whole group, so a
function no longer exported stops being a tool; \`remove\` with \`package\` deletes the group.

CHECK
Re-runs define's type-check over source already defined, registering and persisting nothing. The tool
types are LIVE, so a tool that changes its contract can invalidate a function that was sound when it was
defined — and nothing else would notice, because a defined function is compiled, never re-checked, on
reload. Pass \`name\` for one function or \`package\` for one package; omit both to check everything, this
conversation's session functions included. One row per function: \`total\` is every finding, \`diagnostics\`
the detail — each with a \`rendered\` block to read and a \`label\` to group on, either a tsc code such as
\`TS2339\` or a structural rule (\`CAST-GATE\`, \`ENV-GATE\`, \`SHADOWED\`, \`PARSE\`) — and \`omitted\` the tally
of any the detail cap hid. A row carrying \`definedUnchecked: true\` was registered without a type-check.
READ \`ok\` TOGETHER WITH \`checked\`, on the result and on each row: \`checked: false\` means no type-checker
could run here, so \`ok: true\` says only that nothing was examined. Fix a failure by re-defining.

TWO DEFINITION SHAPES — and neither is an arrow function
  execute — the BODY alone, between braces. There is no function head, so there is nothing to declare and
     no \`=>\` to write.
  define / package — source in METHOD syntax: \`name(params): ReturnType { body }\`. Not \`(args) => { … }\`,
     which is rejected as invalid TypeScript and is the commonest first attempt, because the surrounding
     vocabulary suggests a function expression. Not the \`function\` keyword either, though a leading \`async\`
     or \`function\` is tolerated and stripped.
A \`define\`'s tool NAME is the method name in the source — there is no \`name\` parameter on \`define\`
(\`list\`, \`remove\` and \`check\` take one, to address a function that already exists). Asked for "a tool
called X", write \`X(params): Result { … }\`.
\`define\` must declare a return type: it becomes the tool's result contract — what other bodies are checked
against — so state it exactly. The body is async here too, so \`Promise<T>\` and \`T\` mean the same thing:
write whichever reads better, and \`await\` freely inside either. An \`execute\` needs no return type: its
result is stringified on its way back, and nothing else is ever checked against it.

  execute — { const files = await tool.workspace_action({ action: 'list', prefix: 'charts' });
              return files.length; }

  define — count_plugins(check: string): string {
             const p = await tool.plugin({ action: 'list' });
             const n = p.loaded.filter(pl => pl.name.includes(check)).length;
             return n + ' plugins match "' + check + '"';
           }
           → registers tool "count_plugins" taking { check: string }.

  define, reading the injected context — turn_count(): number {
             const s = await tool.session_action({ action: 'get', sessionId: context.sessionId });
             return s.messages.length;
           }
           → registers tool "turn_count" taking {}.

  package — name: Presence
            definition:
              interface Report { home: boolean; room?: string }
              async function report(): Promise<Report> { … one private helper, shared below … }
              // Whether Mat is at home, in one word.
              export async function where(args: {}): Promise<string> { return (await report()).home ? 'home' : 'out'; }
              // The room Mat was last seen in.
              export async function room(args: {}): Promise<string> { return (await report()).room ?? 'unknown'; }
            → registers tools "Presence__where" and "Presence__room"; \`report\` is not a tool.

Before composing, run \`{ action: 'types' }\` to fetch the declarations of what the available tools' calls
resolve to — write \`await tool.x(...)\` against those real result types instead of guessing shapes.`;

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action:     { type: 'string', enum: ['define', 'execute', 'package', 'check', 'list', 'types', 'remove'], description: 'execute: run a bare body once, now. define: persist a named function as a tool. package: persist a TypeScript module whose exported functions become tools <package>__<function>. check: re-type-check already-defined functions and packages against the current tool types. types: get TypeScript declarations of what a body is graded against. list / remove: manage defined functions and packages.' },
    definition:  { type: 'string', description: 'execute: the bare BODY — the statements between braces, e.g. `{ const xs = await tool.x({}); return xs.length; }`. No function head, no parameters, no `=>`. define: a named FUNCTION, in METHOD syntax — `name(params): ReturnType { body }`. There is NO `=>` form: arrow syntax (`(args) => { … }`) is rejected as invalid TypeScript and is the commonest first attempt, because the surrounding vocabulary suggests one. A leading `async` or `function` is tolerated and stripped; the return type is required. package: the MODULE source — its exported functions become tools and everything else stays private. Stateless: only declarations at the top level (no let/var, bare statements or top-level await).' },
    package:     { type: 'string', description: 'check / remove (optional): the PACKAGE to check or delete — a selector, not the define action (for that, pass action: "package").' },
    scope:       { type: 'string', enum: ['global', 'session'], description: "define only (optional, default 'global'): 'global' when the user asked for the function — saved, and a tool in every conversation; 'session' for a function of your own — only this conversation sees it, though it is stored in the conversation and so survives a restart, a fork, a cut and a compact. A package is always global." },
    description: { type: 'string', description: 'define only (optional): Describe the intent of the function from the context used to create it. Include a clause describing the use-cases for the function tool. Becomes the defined tool\'s description, and therefore it is important to make the description both specific in terms of intent and use-cases. Do not describe the mechanism or execution as this is already clear from the code.' },
    noTypeCheck: { type: 'boolean', description: 'execute / define / package (optional, default false): skip the TypeScript type-check of the body against the live tool types. The check is a strong signal the composition is sound before it is registered/run — leave it on unless you must bypass a spurious error (e.g. composing a tool whose result type is `unknown`). A bypassed error does not go away: it is still there, and will surface later when something unrelated moves, so a function defined this way is marked `definedUnchecked` in `list` and `check` and should be checked again once the obstacle is gone. No effect where no type-checker is available (e.g. the browser) — a definition made there is marked the same way, being equally unverified.' },
    name:       { type: 'string', description: 'NOT for define — a defined tool is named by the method name in its own source. package: the package name (an identifier, no "__"). check / remove: the defined function or package to act on.' },
  },
};

/**
 * Always-injected system-prompt guidance: WHEN to reach for `tool_function` at all, as opposed to how to
 * call it — that detail lives in the tool's own DESCRIPTION, which is read only once the tool is being
 * considered. Deliberately broad and brief: this text is paid for in every conversation, whether the work
 * suits one or not, and a long sales pitch biases a model towards a function on a case too weak to want
 * one. It therefore covers the three lifetimes a body can have — anonymous `execute`, `scope: 'session'`,
 * `scope: 'global'` — rather than the one-shot alone, and qualifies the platform
 * access only a node body has. Constant text, so it is a stable cache prefix (see the `contribute` hook
 * note in CLAUDE.md) rather than something rebuilt per turn.
 */
const MULTI_STAGE_ADVICE = `## tool_function

TypeScript functions that compose registered tools in one pass. Inside one, call any other tool as
\`await tool.x(params)\` and return only what you need — so the listings, rows and file bodies it read on
the way never reach the conversation.

Reach for it when the work is a REDUCTION (a count, a total, an aggregate, a couple of fields out of a
verbose result), a LOOP or a CONDITIONAL over n items, or a multi-step chain that would otherwise cost a
round per step: the function does the whole thing in one call, with no LLM turn between the steps. A
body can be anonymous and one-shot (\`execute\`), or named and saved — for this conversation only
(\`scope: 'session'\`) or for every conversation (\`scope: 'global'\`, the default, for a tool the user asked
for). On node a body may also import platform modules, with the user's permission — see MODULES.

Do NOT wrap a single tool call whose result you are not reducing — call the tool directly.
`;

const errorEvent = (message: string): ToolEvent => ({ type: 'error', message });

function functionTool(machine: MatbotMachine, store: FunctionStore, packages: PackageStore, sessions: SessionFunctions): Tool<ToolResultOf<'tool_function'>> {
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
            if (act.scope !== undefined && act.scope !== 'global' && act.scope !== 'session') { yield errorEvent('define: "scope" must be "global" or "session".'); return; }
            const note = act.noTypeCheck === true ? ' (type-check skipped)' : '';
            const mine = sessionFunctions(ctx.session);
            try {
              if (act.scope === 'session') {
                const { marker, name, parameters } = await sessions.define(ctx, act.definition, act.description, act.noTypeCheck === true);
                yield sessionMarker(marker);
                const params = parameters.map(p => p.name).join(', ');
                yield { type: 'result', value: { message: `Defined session function "${name}"${params ? ` (${params})` : ''}.${note} Callable from your next step, in this conversation only — directly, or as \`await tool.${name}(…)\` from your other functions.`, tool: name, parameters } };
                return;
              }
              const { name, parameters } = await store.define(act.definition, act.description, act.noTypeCheck === true, mine.keys());
              // Promotion: a session function of this name would now be shadowed by its own global
              // successor, and told so every turn. Retire it with the same marker a remove writes.
              const promoted = mine.has(name);
              if (promoted) yield sessionMarker({ op: 'remove', name });
              const params = parameters.map(p => p.name).join(', ');
              yield { type: 'result', value: { message: `Defined tool "${name}"${params ? ` (${params})` : ''}.${note}${promoted ? ' It replaces the session function of that name.' : ''} Call it directly to run.`, tool: name, parameters } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'execute': {
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('execute requires a "definition" — the body, between braces.'); return; }
            let fn: CompiledFn;
            try { fn = await buildBodyFn(machine, act.definition); }
            catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); return; }
            // Type-check the body against the live tool types before running (node only; opt out with
            // noTypeCheck). The snippet is the same wrap the runner compiles — an empty head around the
            // author's own block — so what is graded is exactly what runs, and there is no signature to
            // parse and therefore no head to get wrong.
            const index = machine.ToolTypeIndex;
            if (index !== undefined && act.noTypeCheck !== true) {
              const report = await index.check(`async function __fn() ${act.definition}` + turnContracts(ctx.turnTools));
              if (!report.ok) { yield errorEvent(`type error(s) — fix and re-run, or pass noTypeCheck to bypass:\n${renderCheck(report)}`); return; }
            }
            yield* runFunction(machine, ctx, fn, [], { tool: `${TOOL_NAME} execute`, source: act.definition, gateSubject: EXECUTE_SUBJECT });
            return;
          }
          case 'package': {
            if (typeof act.name !== 'string' || act.name === '') { yield errorEvent('package requires a "name" (the package name).'); return; }
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('package requires a "definition" (the module source).'); return; }
            try {
              const tools = await packages.define(act.name, act.definition, act.noTypeCheck === true, sessionFunctions(ctx.session).keys());
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
              const mine = sessionFunctions(ctx.session);
              const own  = act.name !== undefined ? mine.get(act.name) : undefined;
              const results = act.package !== undefined ? await packages.check(act.package)
                : act.name !== undefined
                  ? (own !== undefined && !await store.has(act.name) ? await sessions.check(ctx, [own]) : await store.check(act.name))
                  : [...await store.check(), ...await packages.check(), ...await sessions.check(ctx, mine.values())];
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
            yield { type: 'result', value: { functions: await store.list(), packages: await packages.list(), sessionFunctions: [...sessionFunctions(ctx.session).values()] } };
            return;
          case 'types': {
            const index = machine.ToolTypeIndex;
            if (index === undefined) {
              yield { type: 'result', value: { available: false, dts: '' } };
              return;
            }
            yield { type: 'result', value: { available: true, dts: `${await index.dts()}${turnContracts(ctx.turnTools)}\n` } };
            return;
          }
          case 'remove': {
            if (typeof act.package === 'string' && act.package !== '') {
              const ok = await packages.remove(act.package);
              yield { type: 'result', value: { message: ok ? `Removed package "${act.package}" and its tools.` : `No package named "${act.package}" was defined here.` } };
              return;
            }
            if (typeof act.name !== 'string' || act.name === '') { yield errorEvent('remove requires a "name" (a function) or a "package".'); return; }
            // A global one first: in the rare case both exist, the session one is already shadowed, and a
            // person saying "remove the X tool" means the one they can see everywhere.
            if (!await store.has(act.name) && sessionFunctions(ctx.session).has(act.name)) {
              yield sessionMarker({ op: 'remove', name: act.name });
              yield { type: 'result', value: { message: `Removed session function "${act.name}".` } };
              return;
            }
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
    manifest: { description: 'Author and run TypeScript functions that compose registered tools (`tool_function`: execute/define/package/check/list/types/remove).' },

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
      const sessionFns = new SessionFunctions(services);
      await fns.reload();
      await pkgs.reload();
      // The registered tools are state derived from the store at setup time, so they must be rebuilt
      // when a deferred StorageBackend swap lands on a different `functions` set. No `replay` — the
      // boot load is above; this reacts only to future swaps.
      services.mounted.observe({ key: 'StorageBackend', signal: lifecycle.signal }, () => void fns.reload().then(() => pkgs.reload()));
      services.tools.register(functionTool(services, fns, pkgs, sessionFns));
      services.systemContext.register(() => MULTI_STAGE_ADVICE);
      // Session functions reach a turn only through here: never registered, offered by the runner each
      // round from the session's own markers. A name a global tool has taken since is withheld, and the
      // model is told why, since it may not have caused the clash and cannot see it any other way.
      services.hooks.register({
        on: 'screen',
        pluginName: PLUGIN_NAME,
        handler: ({ session }) => {
          const shadowed = [...sessionFunctions(session).keys()].filter(n => services.tools.resolve(n) !== null);
          const ephemeral: MessageContent[] = shadowed.map(n => ({
            type: 'text',
            text: `${shadowMessage(n)} — "${n}" is a session function defined earlier in this conversation; define it again under a unique name with scope: 'session'.`,
          }));
          return { tools: current => sessionFns.tools(current), ...(ephemeral.length > 0 ? { ephemeral } : {}) };
        },
      });
    },

    async teardown() { lifecycle?.abort(); store?.removeAll(); packages?.removeAll(); },
  };
}

export const plugin: MatbotPluginSpec = createFunctionToolsPlugin();
