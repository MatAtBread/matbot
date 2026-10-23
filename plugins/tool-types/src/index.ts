import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PLUGIN_API_VERSION, RegistryChangeKind, importPermitted, importableByName } from '@matatbread/matbot-plugin-api';
import type { FunctionRunSettings, FunctionRunner, MatbotMachine, MatbotPluginSpec, ToolCheckReport, ToolTypeIndex } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins } from '@matatbread/matbot-core';
import { buildToolTypesData, compileToolValidators, type ToolTypesData } from './build-dts.js';
import { checkSnippetAgainst } from './checker.js';
import type { ToolValidator } from './validator.js';

export {
  buildMatbotToolsDts, buildToolTypesData, collectToolTypeRoots, compileToolValidators, filterToolTypesData,
  type DtsParts, type MatbotToolsDts, type ToolTypesData, type ToolTypeRoots,
} from './build-dts.js';
export { checkProjectDir, checkSnippetAgainst, type CheckResult } from './checker.js';
export {
  generateValidator, buildToolValidator, compileValidator, compileToolValidator,
  type ValidationError, type Validator, type ValidatorSource, type ToolValidator,
} from './validator.js';

/**
 * What tool-types SUPPLIES: the generated validator for each live tool, keyed by name. This package does
 * type formation and analysis — it derives the dts, the wire contracts and the JSON Schemas from each
 * tool's `ToolContract`, and emits a validator from the checker's resolved params type — but it is not
 * itself a validator and registers no validator service. Enforcement is a consumer's:
 * `@matatbread/matbot-tool-ts-validation` calls this, applies a policy, and registers the
 * `ToolCallValidator` that core consults at the executor.
 *
 * That separation is the point. A code generator (`skills_compiler`, `function-tools`) loads this package
 * for `dts()`/`check()` alone; if loading it also switched input enforcement on, adopting typed codegen
 * would silently start rejecting tool calls.
 *
 * Reached by duck-typing `services.ToolTypeIndex` (the same structural check `asProfileDirectory` uses),
 * so plugin-api's `ToolTypeIndex` need not learn about validation at all.
 */
export interface ToolValidatorSupplier {
  /** Per live tool: its compiled params validator, or the stated reason none could be generated.
   *  Rebuilt with the dts and cached, so this costs nothing after the first call. */
  toolValidators(): Promise<Record<string, ToolValidator>>;
}

/** Structural recovery of the supplier from whatever is registered as `ToolTypeIndex` — method presence,
 *  never `instanceof`, so it survives hot reload and follows a swap. */
export function asToolValidatorSupplier(index: unknown): ToolValidatorSupplier | undefined {
  return typeof (index as ToolValidatorSupplier | undefined)?.toolValidators === 'function'
    ? index as ToolValidatorSupplier
    : undefined;
}

// Split a string on `sep` at bracket-depth 0 only (respecting `<> {} () []`), so a top-level `|` or `,`
// inside a nested type isn't mistaken for a separator.
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && c === sep) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// Flatten a `toolContract` (`ToolContract<Result, Args>`, or a `|`-union of such arms) to the wire's
// `params`/`result` union text — the same projection build-dts derives from source arms.
function splitContract(contract: string): { params: string; result: string } {
  const results: string[] = [], params: string[] = [];
  for (const armText of splitTopLevel(contract, '|')) {
    const m = armText.trim().match(/^ToolContract\s*<([\s\S]*)>$/);
    if (!m) continue;
    const inner = splitTopLevel(m[1]!, ',');
    if (inner[0] !== undefined) results.push(inner[0].trim());
    if (inner[1] !== undefined) params.push(inner[1].trim());
  }
  return { result: results.join(' | ') || 'unknown', params: params.join(' | ') || 'unknown' };
}

// Best-effort JSON-Schema → TypeScript type text. Used only for the params half of a tool that has neither
// a source augmentation nor a `toolContract` (a foreign/MCP proxy): its `inputSchema` is always present, so
// we synthesise *something* structural rather than leaving `unknown` — so a composer sees real fields. There
// is no 1:1 JSON-Schema↔TS mapping; this is deliberately shallow and total — anything unrecognised degrades
// to `unknown` (never throws), and the output is purely structural (no named refs) so the dts stays
// self-contained. `unknown` here flows back through `ArmCallSig`'s `unknown extends P` branch to an
// optional param, so an opaque schema still leaves the tool callable arg-less.
//   Enhancement (parked, not needed now): a fuller conversion — $ref/allOf/format/pattern/const/tuples —
//   could be delegated to a package like `json-schema-to-typescript`. This dependency-free shallow pass is
//   enough to give a composer real fields for the common MCP shapes.
function schemaToTs(schema: unknown, depth = 0): string {
  if (depth > 6 || schema === null || typeof schema !== 'object') return 'unknown';
  const s = schema as Record<string, unknown>;
  const lit = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? JSON.stringify(v) : 'unknown';

  const union = s['anyOf'] ?? s['oneOf'];
  if (Array.isArray(union)) {
    const parts = [...new Set(union.map(u => schemaToTs(u, depth + 1)))];
    return parts.length ? parts.join(' | ') : 'unknown';
  }
  if (Array.isArray(s['enum'])) {
    const parts = [...new Set(s['enum'].map(lit))];
    return parts.length ? parts.join(' | ') : 'unknown';
  }
  const type = s['type'];
  if (Array.isArray(type)) return [...new Set(type.map(t => schemaToTs({ ...s, type: t }, depth)))].join(' | ') || 'unknown';
  switch (type) {
    case 'string':  return 'string';
    case 'integer':
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'null':    return 'null';
    case 'array': {
      const items = Array.isArray(s['items']) ? 'unknown' : schemaToTs(s['items'], depth + 1);
      return /[ |&]/.test(items) ? `Array<${items}>` : `${items}[]`;
    }
  }
  const props = s['properties'] && typeof s['properties'] === 'object' ? s['properties'] as Record<string, unknown> : undefined;
  if (props && Object.keys(props).length > 0) {
    const required = new Set(Array.isArray(s['required']) ? s['required'] as unknown[] : []);
    const members = Object.entries(props).map(([k, v]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${key}${required.has(k) ? '' : '?'}: ${schemaToTs(v, depth + 1)}`;
    });
    return `{ ${members.join('; ')} }`;
  }
  if (type === 'object') {
    const ap = s['additionalProperties'];
    return ap !== null && typeof ap === 'object' ? `Record<string, ${schemaToTs(ap, depth + 1)}>` : 'Record<string, unknown>';
  }
  return 'unknown';
}

/** Everything a build reads from the live machine, gathered before the build's first await. */
export interface ToolTypesInputs {
  projectRoot:        string;
  pluginEntryUrls:    string[];
  /** Absent ⇒ every scanned tool, for a build meant to serve any live set (see `filterToolTypesData`). */
  liveToolNames?:     string[];
  syntheticContracts: Record<string, string>;
}

/** Where the index gets a build from on a miss. The default builds one; a specialisation may find one. */
export type ToolTypesFill = (inputs: ToolTypesInputs) => Promise<ToolTypesData | null>;

export const buildToolTypes: ToolTypesFill = i =>
  buildToolTypesData(i.projectRoot, i.pluginEntryUrls, i.liveToolNames, i.syntheticContracts);

/**
 * Derives (via {@link buildToolTypesData}) and caches the `.d.ts` of what the loaded tools' calls resolve
 * to, invalidating on any tool-registry change. The scan is driven off the loaded plugins' `resolvedUrl`s —
 * the real source each tool was loaded from — so builtin, compiled, and installed plugins are all covered
 * (the types are erased at runtime, but the `.ts` the runtime loaded from is still on disk). A source-less
 * tool (a `function-tools` function; the `tool-store` per-namespace tool) carries its contract on the
 * registered `Tool` as a `toolContract` string, appended in a second augmentation block; a name the scan
 * already declares is skipped, so nothing is declared twice. `declare const tool: ToolProxy` (mapped over
 * the merged `ToolContracts`) plus its override factory `toolInContext` is what generators call.
 */
/** The two arrays a runner states, printed: a stable fingerprint of the environment a check's verdict
 *  was reached under, for a caller that PERSISTS the verdict (`function-tools` stores one beside each
 *  definition and compares it). Sorted and printed rather than identity-derived, because it has to
 *  survive a restart — unlike the `paths` cache, whose job is the opposite and which keys on the array
 *  itself. */
function fingerprintOf(runner: FunctionRunner | undefined, settings: FunctionRunSettings | undefined): string {
  if (runner === undefined) return 'no-runner';
  const permit = settings?.permittedImports;
  return `permit=${permit === undefined ? '*' : [...permit].sort().join(',')};`
       + `withheld=${[...(runner.withheldGlobals ?? [])].sort().join(',')}`;
}

export class ToolTypeIndexImpl implements ToolTypeIndex {
  private readonly machine: MatbotMachine;
  private readonly fill: ToolTypesFill;
  private readonly ac = new AbortController();
  private covered = new Set<string>();   // tool names the source scan already declares (registry-block dedup)
  private cache: string | null = null;   // null ⇒ (re)build needed
  private contracts: Record<string, { params: string; result: string }> = {};   // per-tool wire contract
  private validators: Record<string, ToolValidator> = {};                       // per-tool compiled validator
  private apiExports: string[] = [];     // plugin-api type export names (for importing those a toolContract names)
  private generation = 0;                // tool registry changes seen
  private builtFor = -1;                 // the generation the cached build reflects
  private building: Promise<void> | null = null;

  constructor(machine: MatbotMachine, fill: ToolTypesFill = buildToolTypes) {
    this.machine = machine;
    this.fill = fill;
    // Any tool CRUD invalidates the generated dts; the event itself carries nothing we need.
    //
    // A `FunctionRunner` arriving or leaving deliberately does NOT, though it is the obvious thing to
    // reach for now that the runner is a plugin and can appear after a dts has been handed out. Nothing
    // derived from it is held: each `dts`/`check`/`environment` reads the runner and its settings once at
    // its start, and the one cache over them — {@link importPaths} — keys on the permit list's CONTENT,
    // so a different list is a different key. What IS cached is the source scan, which the
    // runner has no part in. Subscribing would throw away a good TypeScript build every time the runner
    // was registered or hot-reloaded, to recompute something that was never stale.
    machine.Notifier.consume(() => { this.generation++; }, this.ac.signal,
      n => n.kind === RegistryChangeKind && n.registry === 'tools');
  }

  close(): void { this.ac.abort(); }

  // One build at a time, joined by every caller that arrives while it runs: each would otherwise build its
  // own Program, synchronously and one after another. A caller that arrives after a registry change waits
  // for a build that includes it, rather than taking one already under way from before it.
  private async ensureBuilt(): Promise<void> {
    const wanted = this.generation;
    while (this.builtFor < wanted) {
      this.building ??= this.build().finally(() => { this.building = null; });
      await this.building;
    }
  }

  private async build(): Promise<void> {
    // Read before anything is awaited, with the live tool list: a change that lands while this builds
    // leaves the result stale, for the next caller to rebuild, instead of being marked seen.
    const generation = this.generation;
    const root   = this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.';
    // Scan the source each loaded plugin was actually loaded from (its resolvedUrl) — builtin, compiled
    // (.compiled-plugins/), or installed (.plugins/) alike — so every registered tool's real augmentation
    // is read. build-dts UNIONs a glob of the monorepo `plugins/` tree onto these roots (not a fallback:
    // it catches host-constructed builtins that have no resolvedUrl), so the scanned set is a SUPERSET of
    // the loaded one — wherever that tree exists, plugins for other runtimes and plugins nobody loaded are
    // read too. Hence the live tool names: a scanned root may supply a tool's contract, never the fact that
    // the tool exists. Otherwise the dts declares uncallable tools (`telegram_send` from an unloaded
    // telegram frontend), which `check()` then grades generated code against — clean typecheck, "not
    // registered" at runtime. What the scan CAN'T settle is two roots declaring one live name; that stays
    // Program-order and audible via `conflicts`.
    const urls   = getRegisteredPlugins().map(p => p.resolvedUrl).filter((u): u is string => u !== undefined);
    // A tool built at runtime declares its contract as a string, having no source to augment from. The
    // scan cannot see those, so they are handed over to be typed from a virtual augmentation — without
    // which they were described to the model in full and then enforced only by their loose
    // `inputSchema`, which is backwards: their params were authored by an LLM, not a compiler.
    const live      = this.machine.tools.list();
    const synthetic = Object.fromEntries(
      live.flatMap(t => (t.toolContract !== undefined ? [[t.name, t.toolContract] as const] : [])),
    );
    const built  = await this.fill({
      projectRoot: root, pluginEntryUrls: urls, liveToolNames: live.map(t => t.name), syntheticContracts: synthetic,
    });
    this.cache      = built?.dts ?? '';
    this.covered    = new Set([...(built?.tools.emitted ?? []), ...(built?.tools.unknown ?? [])]);
    this.contracts  = built?.contracts ?? {};
    this.validators = compileToolValidators(built?.validators ?? {});
    this.apiExports = built?.apiExports ?? [];
    this.builtFor   = generation;
  }

  /** The runner and its settings, read once for one invocation of this index — a `dts`, a `check` — and
   *  passed to everything inside it. Per invocation, never cached: whose settings they are depends on how
   *  the settings store is partitioned, and the next invocation may be another principal's. */
  private async runnerNow(): Promise<{ runner: FunctionRunner | undefined; settings: FunctionRunSettings | undefined }> {
    const runner = this.machine.FunctionRunner;
    return { runner, settings: await runner?.settings?.() };
  }

  async dts(): Promise<string> { return this.dtsUnder(await this.runnerNow()); }

  private async dtsUnder(env: { runner: FunctionRunner | undefined; settings: FunctionRunSettings | undefined }): Promise<string> {
    await this.ensureBuilt();
    // `tool` — the injected proxy `function-tools`/compiled skills call — is a `ToolProxy`, a mapped type
    // over the (augmented) `ToolContracts`: each multi-arm entry becomes an overload set, so `await
    // tool.x(params)` narrows its result by the params, and a non-existent tool name is a compile error.
    // `toolInContext(override)` is the sibling factory for a context override. Both derived, never
    // hand-authored; `check()` uses this same string, so what a generator is shown is exactly what it is
    // graded against — which is also why `context` is declared here and not merely described in prose:
    // undeclared, every body reading it would fail the very check this string backs.
    // The import line is in the dts rather than in prose on the wire because this string is what a body is
    // GRADED against: an author told elsewhere that imports work would still have to guess whether the
    // checker agreed. It names what is permitted HERE, from the live set, rather than claiming imports
    // work in general — a module outside the set does not resolve, which is the whole point of scoping
    // the types to it. `require` and the rest are rejected by the env gate, not left to fail at a call.
    return `${this.registryBlock(this.cache!)}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\ndeclare const toolInContext: import('@matatbread/matbot-plugin-api').ToolBox;\ndeclare const context: import('@matatbread/matbot-plugin-api').ComposedCallContext;\n${await this.importNote(env.runner, env.settings)}`;
  }

  async wireContracts(): Promise<Record<string, { params: string; result: string }>> {
    await this.ensureBuilt();
    const out: Record<string, { params: string; result: string }> = {};
    for (const [name, c] of Object.entries(this.contracts)) out[name] = c;   // source tools: arms flattened by build-dts
    for (const t of this.machine.tools.list()) {                             // source-less tools: split their toolContract
      if (out[t.name] !== undefined || t.toolContract === undefined) continue;
      out[t.name] = splitContract(t.toolContract);
    }
    return out;
  }

  /**
   * `paths` for the modules this installation permits a body to import, so `await import('node:os')` is
   * checked against the real signatures and a module outside the permitted set simply does not resolve.
   *
   * The set is read off the {@link FunctionRunner}, which is where it lives because the runner IS the
   * execution environment and two consumers need one answer — the capability that imports, and this,
   * which types it. An absent restriction means every builtin: a body may ASK for anything and the gate
   * decides, so refusing to type what it may legitimately ask for would make the prompt unreachable.
   * Resolved from THIS package, where `@types/node` is a dependency: the program is
   * rooted at the `matbot.yaml` directory, which under pnpm and in any published install has no
   * `node_modules/@types` in its lookup chain, so nothing would resolve from there.
   *
   * A builtin gets its real declaration file. A bare package name is left to ordinary resolution: if it
   * is installed it types properly, and if it is not, the error is honest.
   *
   * A path or a URL gets nothing, because a body cannot import one at all (`importableByName`), and
   * IMPORT-GATE says so at the check.
   */
  /** {@link importPaths} is read twice per check — once for the program's `paths`, once by {@link
   *  importNote} through the dts — and it walks every builtin with a stat apiece. Cached against the
   *  CONTENT of the permit list it was computed from: settings are read afresh per invocation, so each
   *  read is a new array and an identity key would never hit. */
  private pathsFor?: { key: string; paths: Record<string, string[]> };

  private async importPaths(restricted: readonly string[] | undefined): Promise<Record<string, string[]>> {
    const key = restricted === undefined ? '*' : JSON.stringify(restricted);
    if (this.pathsFor !== undefined && this.pathsFor.key === key) return this.pathsFor.paths;
    const paths = await this.computeImportPaths(restricted);
    this.pathsFor = { key, paths };
    return paths;
  }

  private async computeImportPaths(restricted: readonly string[] | undefined): Promise<Record<string, string[]>> {
    // Absent ⇒ unrestricted, so every builtin is typed and the gate decides each import at the call. A
    // configured restriction narrows this to its own subset, which is what makes a forbidden module a
    // COMPILE error rather than something that typechecks and is refused later.
    if (restricted?.length === 0) return {};
    const { builtinModules } = await import('node:module');
    const req = createRequire(import.meta.url);
    const nodeTypes = dirname(req.resolve('@types/node/package.json'));
    const out: Record<string, string[]> = {};
    // Every builtin tested against the shared boundary rule, rather than an entry's own spelling being
    // expanded here: `node:fs` admits `node:fs/promises` at the gate, so it must TYPE the submodule too.
    // Emitting the exact specifier alone left a permitted import failing the check, reachable only with
    // `noTypeCheck` — the one divergence between what runs and what is graded.
    // What the GATE would allow, which is the only set worth typing: unrestricted admits any spelling, a
    // restriction admits what its boundary rule admits. Anything else is a divergence between what runs
    // and what is graded, in one direction or the other.
    const allowed = (spec: string): boolean => restricted === undefined || importPermitted(restricted, spec);
    for (const m of builtinModules) {
      if (m.startsWith('_')) continue;
      // Some entries ALREADY carry the prefix — node:sea, node:sqlite, node:test, node:test/reporters,
      // which have no unprefixed spelling — so prefixing unconditionally wrote `node:node:sqlite`, and
      // those four got no entry at all. `await import('node:sqlite')` then failed the check with tsc's
      // "install type definitions for node", which is the message IMPORT-GATE exists to replace.
      const prefixed = m.startsWith('node:');
      const bare = prefixed ? m.slice('node:'.length) : m;
      const file = declarationFile(nodeTypes, bare);
      if (file === undefined) continue;
      if (allowed(`node:${bare}`)) out[`node:${bare}`] = [file];
      // The UNPREFIXED spelling too, where node has one: `import('os')` resolves to `node:os` at run
      // time, and a bare specifier is the spelling a model reaches for first. Allowed by the PREFIXED
      // spelling, because that is what the gate asks about (`canonicalImport`) — so `['node:']` types
      // `os`, as the gate admits it.
      if (!prefixed && allowed(`node:${bare}`)) out[bare] = [file];
    }
    return out;
  }

  /** The part of the dts that is about imports: which modules this install permits AND which of those
   *  have types, that second half being this package's own knowledge. Everything else about the
   *  environment — the gate, what is not in scope — is the runner's to state, and is appended verbatim. */
  private async importNote(runner: FunctionRunner | undefined, settings: FunctionRunSettings | undefined): Promise<string> {
    const restricted = settings?.permittedImports;
    const typed = new Set(Object.keys(await this.importPaths(restricted)));
    // "Switched off" is `permit: []` and nothing else — the one configured "never". Derived from the
    // TYPED set instead, it fired for any restriction naming no builtin (`permit: ['lodash']`), telling
    // an author imports were off while the gate was perfectly willing to ask about one.
    // An entry is typed if it names a declaration itself or admits one — `node:` and `node:fs` both do,
    // through their submodules. A bare package admits none, which is a stated refusal rather than a fake
    // type, so the listing says so where the author will read it.
    const covered = (p: string): boolean => typed.has(p) || [...typed].some(t => importPermitted([p], t));
    // The EXPANDED set, because a prefix is not an answer: `node:` tells an author nothing about which
    // builtins exist, and `node:fs` hides that `node:fs/promises` came with it. Restriction entries that
    // admit no declaration at all are listed after it, marked — a bare package is untypeable here, which
    // is a stated refusal rather than a fake type, and the author needs to know which it is.
    // A bare `node` is the one entry that is not merely untypeable but unimportable: the boundary rule
    // reads it as a PACKAGE of that name (it admits `node/sub`, never `node:os`), so an install meaning
    // the builtins and missing the colon permits nothing a body can use. Listing it as "untyped —
    // import it only with noTypeCheck" invited exactly the attempt that cannot work, so it says what it is.
    // A path or a URL is unimportable outright, whoever's runner listed it: the gate never asks about one.
    const mark = (p: string): string => p === 'node'
      ? `${p}   (a PACKAGE of that name — not node's builtins, which are spelled 'node:fs'; nothing here can import it)`
      : !importableByName(p.replace(/\/$/, ''))
        ? `${p}   (a path or a URL — a body imports only builtins and packages, by name; nothing here can import it)`
        : `${p}   (untyped — import it only with noTypeCheck)`;
    const listing = [
      ...[...typed].sort(),
      ...(restricted ?? []).filter(p => !covered(p)).sort().map(mark),
    ];
    // Whether an import is GATED is whether a runner routes it, not whether a restriction exists. With no
    // runner nothing rewrites `import(…)`: it reaches node's own loader, unasked and unchecked. Saying
    // "you will be asked" there is a promise nothing keeps, and a body discovers the contradiction the
    // first time it imports something.
    const gated = runner !== undefined;
    const subject = gated ? ', each subject to permission at the call' : '';
    const note = restricted !== undefined && restricted.length === 0
      ? `// Module imports are switched off on this installation.\n`
      : restricted === undefined
        ? `// A body may import node builtins${subject}${gated ? ' — you will be asked\n// the first time' : ''}: const fs = await import('node:fs/promises');\n`
        : `// A body may import these${subject}:\n`
          + `${listing.map(p => `//   ${p}`).join('\n')}\n`;
    // Composed from what the runner STATES — the permitted set above, and the identifiers it does not
    // bind — never from prose it supplies: the facts are the runner's, the wording is this file's, and
    // the same two arrays are what IMPORT-GATE and ENV-GATE enforce, so the note cannot drift from them.
    const withheld = runner?.withheldGlobals ?? [];
    return `${note}`
      + (withheld.length > 0
          ? `// A body is a bare async function, not a module, and not every global is in scope. Absent: ${withheld.join(', ')}, import.meta.\n`
          : '');
  }

  /** The two arrays again, printed: a stable fingerprint of the environment a check's verdict was
   *  reached under, for a caller that PERSISTS the verdict (`function-tools` stores one beside each
   *  definition). Sorted and printed rather than identity-derived, because it has to survive a restart
   *  — unlike {@link pathsFor}, whose job is the opposite and which keys on the array itself. */
  async environment(): Promise<string> {
    const { runner, settings } = await this.runnerNow();
    return fingerprintOf(runner, settings);
  }

  async check(snippet: string): Promise<ToolCheckReport> {
    // ABSOLUTE, always. The virtual file is named `<root>/…`, and `ts.createProgram` normalises a
    // relative one to a different string than the hook compares against — so `getSourceFile(virtual)`
    // missed, there were no files to check, and the snippet came back clean whatever was in it. A
    // checker that silently passes everything is the one failure mode this path must not have.
    const root = resolve(this.machine.configPath !== undefined ? dirname(this.machine.configPath) : '.');
    // Read ONCE, before anything else: the dts, the `paths`, the worker's restriction and the fingerprint
    // stamped below all have to describe one environment — the one this was graded against — not
    // whatever is current by the time each is computed.
    const env = await this.runnerNow();
    const prefix = `${await this.dtsUnder(env)}\n`;
    const source = `${prefix}${snippet}\nexport {};\n`;           // trailing export ⇒ this file is a module

    // Anchor `@matatbread/matbot-plugin-api` — it isn't a bare-resolvable dep of the project root, so map it
    // to the monorepo source (or the installed package). Without this the imports fail and every type
    // collapses to `any`, silently passing bad snippets.
    const monorepoApi = join(root, 'plugin-api', 'src', 'index.ts');
    let apiIndex: string | undefined = existsSync(monorepoApi) ? monorepoApi : undefined;
    if (apiIndex === undefined) {
      try { apiIndex = createRequire(join(root, '_')).resolve('@matatbread/matbot-plugin-api'); } catch { /* unresolved */ }
    }

    // Worker-hosted check (see checker.ts) — off the main loop, and each diagnostic comes back as an
    // annotated block (caret-anchored frame, related locations, HINT) with snippet-relative positions.
    const { runner, settings } = env;
    const importPaths = await this.importPaths(settings?.permittedImports);
    // The restriction goes too, and not only its `paths`: one builtin's declaration file drags in the
    // ambient `declare module 'node:…'` blocks of everything its own declarations reference, so a
    // forbidden specifier resolves through the back door and typechecks clean. The checker closes that
    // structurally. Absent stays absent — unrestricted means nothing to enforce.
    const restricted = settings?.permittedImports;
    const withheld   = runner?.withheldGlobals;
    const report = await checkSnippetAgainst({
      root, source,
      prefixLen: prefix.length,
      prefixLines: prefix.split('\n').length - 1,
      ...(apiIndex !== undefined ? { apiIndexPath: apiIndex } : {}),
      ...(Object.keys(importPaths).length > 0 ? { importPaths } : {}),
      globalTypes: nodeGlobalTypes(),
      ...(restricted !== undefined ? { permittedImports: restricted } : {}),
      // ENV-GATE's list, from the runner that withholds them. Absent with no runner, which is correct:
      // nothing is withheld there either, so there is nothing to reject.
      ...(withheld !== undefined ? { withheldGlobals: withheld } : {}),
    });
    // Stamped here and nowhere else, from the same two lists that were just passed to the worker, so the
    // fingerprint cannot describe an environment other than the one graded against. Only on a verdict
    // that exists: `checked: false` has nothing to be stale.
    return report.checked ? { ...report, environment: fingerprintOf(runner, settings) } : report;
  }

  // Every live tool the source scan didn't already declare: a source-less tool that carries its contract as
  // a `toolContract` string (a `function-tools` function; the `tool-store` per-namespace tool), spliced
  // verbatim; plus any tool with neither augmentation nor `toolContract` (a foreign/MCP proxy, or a plugin
  // with no resolvable source) — for which the result stays `unknown` but the params are synthesised from
  // the tool's (always-present) `inputSchema` (see {@link schemaToTs}), so it isn't a bare
  // `ToolContract<unknown, unknown>` and a composer sees real fields. Either way it appears in
  // `keyof ToolContracts`, hence in `ToolProxy`, and stays callable. Names the source scan already declared
  // are skipped, so nothing is declared twice. `ToolContract` is referenced bare — it resolves to the
  // top-of-file import the derived block emits (every arm references it); when the scan produced nothing to
  // import it (no source resolved, or an all-`MatbotServices` block), this block supplies that one import.
  private registryBlock(derived: string): string {
    const arms: string[] = [];
    for (const t of this.machine.tools.list()) {
      if (this.covered.has(t.name)) continue;
      arms.push(`    ${JSON.stringify(t.name)}: ${t.toolContract ?? `ToolContract<unknown, ${schemaToTs(t.inputSchema)}>`};`);
    }
    if (arms.length === 0) return derived;
    const body = arms.join('\n');
    // Import the plugin-api types these arms reference — `ToolContract` always, plus any plugin-api export a
    // source-less `toolContract` names (e.g. `StoreQuery`) — minus whatever the derived block already imports
    // (importing a name twice is a redeclaration error). A synthetic tool inlines its own shape types, so the
    // only names left here are genuine plugin-api exports.
    const alreadyImported = new Set(
      (derived.match(/^import type \{([^}]*)\} from '@matatbread\/matbot-plugin-api'/m)?.[1] ?? '')
        .split(',').map(s => s.trim()).filter(Boolean),
    );
    const referenced = ['ToolContract', ...this.apiExports.filter(n => new RegExp(`\\b${n}\\b`).test(body))];
    const needed = [...new Set(referenced)].filter(n => !alreadyImported.has(n));
    const head = needed.length
      ? `${derived === '' ? "import '@matatbread/matbot-plugin-api';\n" : ''}import type { ${needed.join(', ')} } from '@matatbread/matbot-plugin-api';\n`
      : '';
    return `${head}${derived}\ndeclare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n${body}\n  }\n}\n`;
  }

  async toolValidators(): Promise<Record<string, ToolValidator>> {
    await this.ensureBuilt();
    return this.validators;
  }
}

export function createToolTypesPlugin(): MatbotPluginSpec {
  let impl: ToolTypeIndexImpl | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Node-only ToolTypeIndex service: derives a .d.ts of the loaded tools\' result/service types so tool-call code generators and composers (skills_compiler, function-tools) can type what `tool` calls resolve to.' },

    async setup(services) {
      impl = new ToolTypeIndexImpl(services);
      await services.register('ToolTypeIndex', impl);
    },

    async teardown() { impl?.close(); },
  };
}

export const plugin: MatbotPluginSpec = createToolTypesPlugin();


// The node globals a body has that the standard library does not declare: `Buffer`, and its overloads in
// buffer.buffer.d.ts. The rest of what a body is given (`fetch`, the timers, `console`, `TextEncoder`,
// `atob`) is in lib.dom. Loaded whether or not the runner withholds it, since ENV-GATE rejects a withheld
// name either way, and with no runner a body really has it.
function nodeGlobalTypes(): string[] {
  const nodeTypes = dirname(createRequire(import.meta.url).resolve('@types/node/package.json'));
  return ['buffer.buffer.d.ts', 'buffer.d.ts'].map(f => join(nodeTypes, f)).filter(f => existsSync(f));
}

// Where @types/node declares a builtin. Most have a file of their own, but a few subpaths are declared
// inside their parent's (`path/posix` in path.d.ts, `util/types` in util.d.ts, `test/reporters` in
// test.d.ts), and skipping those left a module the gate admits failing the check. The parent is taken
// only if it actually declares the module under one spelling or the other, so a builtin @types/node
// knows nothing about still gets no entry rather than a path that types something else.
function declarationFile(nodeTypes: string, bare: string): string | undefined {
  const own = join(nodeTypes, `${bare}.d.ts`);
  if (existsSync(own)) return own;
  const slash = bare.indexOf('/');
  if (slash < 0) return undefined;
  const parent = join(nodeTypes, `${bare.slice(0, slash)}.d.ts`);
  if (!existsSync(parent)) return undefined;
  const text = readFileSync(parent, 'utf8');
  return [bare, `node:${bare}`].some(m => text.includes(`declare module "${m}"`) || text.includes(`declare module '${m}'`))
    ? parent : undefined;
}
