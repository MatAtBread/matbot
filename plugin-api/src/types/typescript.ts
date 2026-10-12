// ── TypeScript ──────────────────────────────────────────────────────────────

/**
 * Erases TypeScript types from a source string, returning runnable JavaScript. Type-stripping is
 * foundational — the harness ships raw `.ts` and any code compiled at runtime must have its types
 * removed before it can execute — so every execution environment provides one, and it lives as a fixed
 * runtime capability (on {@link MatbotRuntime}) the host supplies per platform, not a swappable service:
 * node uses its built-in `stripTypeScriptTypes`, the browser bundle uses sucrase. A consumer that
 * compiles source at runtime (e.g. `tool_function`) calls this instead of importing a platform stripper.
 *
 * `strip` may be async: a platform whose stripper loads lazily (the browser fetches sucrase on first use)
 * returns a promise; a synchronous stripper (node) returns the string directly — callers `await` either.
 * It is type-erasure, not full transpilation: node's stripper is erasable-only (enums/namespaces throw),
 * sucrase is more permissive, so authors should keep to erasable TypeScript to stay portable.
 */
export interface TypeScriptStripper {
  strip(source: string): string | Promise<string>;
}

/**
 * Optional, host-supplied: turns model-authored TypeScript into something runnable, and is the
 * environment it runs in. How it gets there — strip and compile, transform, interpret — is its own
 * business; the rest of this interface is one value it is GIVEN per call, and two facts about its
 * environment that nothing else can know.
 *
 * Its first job is bounding a body's SYNCHRONOUS execution. Model-authored code runs on the one event
 * loop every session, frontend and schedule shares, so a loop that never awaits freezes all of them —
 * and nothing in-process can stop it, an abort signal included, since stopping needs the loop to yield.
 * Only the stretches between awaits are bounded: a body waiting on a slow tool call is not doing work.
 *
 * Absent ⇒ a consumer compiles the code itself however it can, which drops every part of this at once
 * and not just the bound: nothing is withheld from the body, `import()` reaches whatever the platform
 * natively resolves rather than the loader it was passed, and {@link permittedImports} has no carrier and
 * so restricts nothing. That is all a platform with no way to interrupt synchronous code
 * and no module hook (the browser) can do, and it is the browser's permanent state rather than a
 * misconfiguration — so a node host seeds one unconditionally. An embedder may register its own.
 */
export interface FunctionRunner {
  /**
   * Compile `source` — a TypeScript expression evaluating to an async function — and return something
   * that calls it. Throws on a syntax error. A call stopped at the limit rejects with an error whose
   * `code` is {@link FUNCTION_TIMEOUT}.
   *
   * An EXPRESSION, complete with its own parameter list, rather than a body plus names to bind: a body is
   * not valid alone — `return` at its top level is a syntax error — so every runner would have to wrap it
   * before it could strip or parse it.
   *
   * TypeScript, not erased JavaScript, because erasing is part of running it.
   *
   * `importModule` is handed to each call, and is what a body's `import(…)` should reach: the consumer's
   * gated loader, which closes over that invocation. A runner that rewrites `import(…)` resolves it to
   * this; one that does not simply ignores the argument. How it gets into scope — a parameter the runner
   * names itself, a closure — is internal, and nothing outside declares or sees it: the type-check runs
   * on the source as the author wrote it, before any of this.
   */
  compile(source: string): (importModule: (spec: string, options?: ImportCallOptions) => Promise<unknown>, ...args: unknown[]) => Promise<unknown>;
  /**
   * An optional RESTRICTION on what a body may import, as exact specifiers or prefixes (`['node:']`).
   *
   * **Absent ⇒ no restriction**, which is the default: every specifier may be asked about, and the
   * per-import {@link PermissionGate} decision is the control. That way round because a gate that is
   * never reached is not a gate — an allow-list defaulting to empty refuses before anyone can be asked,
   * which is precisely the behaviour a permission prompt exists to replace. An empty array means the
   * opposite of absent: nothing may be imported, and nobody is asked.
   *
   * What it is FOR is the case a prompt cannot express: a deployment that wants a module forbidden
   * outright, with no human able to allow it. A policy has no stored "always deny" — a refusal is a
   * decision about one act — so this is the only way to say "never", and it is installation authoring.
   *
   * It lives on the runner because the runner IS the execution environment, and because two consumers
   * need one answer: the capability that performs the import, and the type index that declares the
   * reachable set to the author. Spelled as a plugin setting instead, each would have to read the other
   * plugin's namespace.
   *
   * An entry matches a specifier exactly, or as a prefix ending at a BOUNDARY — its own trailing `/` or
   * `:`, or the next `/` in the specifier. So `node:` admits every builtin and `node:fs` admits
   * `node:fs/promises`, while `lodash` does NOT admit `lodashhack`: a bare string prefix would let an
   * entry admit a sibling whose name merely begins the same way, which is the whole value of naming one.
   * It bounds what may be ASKED — it grants nothing by itself — and only ever among what
   * {@link importableByName} admits, so an entry naming a path or a URL admits nothing.
   */
  readonly permittedImports?: readonly string[];
  /**
   * Turn a granted specifier into a module — a builtin or an installed package, never a path or a URL
   * (see {@link importableByName}). The runner's rather than a plain `import()` at the call site because
   * where a package resolves FROM is the runner's business: node's resolves from the runner's own module.
   * `options` is the import's second argument, passed through as written, so an import attribute
   * (`{ with: { type: 'json' } }`) reaches the loader. Absent ⇒ the caller falls back to a dynamic import.
   *
   * It is reached only after the gate has allowed this specifier for this function, and it performs no
   * check of its own — a capability, not a policy.
   */
  import?(spec: string, options?: ImportCallOptions): Promise<unknown>;
  /**
   * Identifiers a body does NOT have — anything this runner withholds, shadows or never binds (node's
   * withholds `process`, `globalThis`, `Buffer`, `eval` and `Function`, and names the phantom
   * `require`/`module`/`__dirname` too, which never existed in a bare function expression but whose node
   * types would otherwise make one typecheck and then fail at the first call).
   *
   * Stated here because only the runner knows, and a checker grading a body must REJECT them: a name
   * shadowed but not rejected typechecks and fails at the first call, which is the one failure a check
   * gate exists to prevent. The second consumer of a list is why it is not kept privately, exactly as
   * for {@link permittedImports}.
   *
   * Absent ⇒ nothing is claimed, not that nothing is withheld.
   */
  readonly withheldGlobals?: readonly string[];
}

/** The `code` on the error a {@link FunctionRunner} rejects with when it stops a run at its limit, so a
 *  consumer can tell a stopped runaway from an ordinary failure without matching message text. */
export const FUNCTION_TIMEOUT = 'FUNCTION_TIMEOUT';


/**
 * Whether `spec` names a module the way a `tool_function` body may import one: a node builtin (`node:fs`)
 * or an installed package (`lodash`, `@scope/pkg/sub`). Never a path, a URL or any other scheme.
 *
 * Downloading or placing code is what a plugin install is for. It is reviewed and versioned, and it has
 * its own gate. A body is too lightweight a thing to recommend it from. Paths are refused for a second
 * reason: they defeat {@link importPermitted}, which matches strings, so `./lib/../../x` "starts with"
 * `./lib/` and resolves outside it. A `.` or `..` segment in a package subpath is refused for the same
 * reason, because a package with no `exports` map resolves it as a path.
 *
 * Shared because three places must agree: the gate in `function-tools`, the runner, and the type-check.
 */
export const importableByName = (spec: string): boolean =>
  spec !== ''
  && !/^[./\\]/.test(spec)
  && !spec.includes('\\')
  && (spec.startsWith('node:') || !/^[a-z][a-z0-9+.-]*:/i.test(spec))
  && !spec.split('/').some(seg => seg === '.' || seg === '..');

/**
 * Whether {@link FunctionRunner.permittedImports} admits `spec` — the boundary rule that interface
 * documents, as a function, because two packages read the same list and must agree: `function-tools`
 * decides whether to ask about an import, and `tool-types` decides which modules to TYPE. They had a copy
 * each, and they drifted exactly where it hurts — `node:fs` admitted `node:fs/promises` at the gate while
 * the checker declared only `node:fs`, so a permitted subpath failed the check and needed `noTypeCheck`
 * to run at all.
 *
 * A prefix must end at a boundary: its own trailing `/` or `:`, or the next `/` in the specifier. A bare
 * `startsWith` let an entry admit a sibling whose name merely begins the same way, which is the whole
 * value of naming one. A specifier {@link importableByName} refuses is never admitted, whatever the list
 * says, since string matching cannot see what `..` does.
 */
export const importPermitted = (permits: readonly string[], spec: string): boolean =>
  importableByName(spec) && permits.some(p => spec === p
    || (p.endsWith('/') || p.endsWith(':') ? spec.startsWith(p) : spec.startsWith(`${p}/`)));

/**
 * One finding from {@link ToolTypeIndex.check} — the record, not a rendering of it.
 *
 * `rendered` travels WITH the record rather than being left for the consumer to rebuild: the annotated
 * form (caret-anchored frame, related locations, a directed hint) is the thing a model repairs from,
 * and the renderer lives behind the service. So a consumer displays `rendered` and counts, groups or
 * routes on the fields — instead of regexing `line \d+ TS\d+` back out of prose, which is what the
 * flattened `string[]` made every consumer do.
 */
export interface ToolCheckDiagnostic {
  /** The rule's one name, in every renderer: `TS2339`, or a structural rule's own name — `CAST-GATE`,
   *  `ENV-GATE` for a global the runner does not define. */
  label:    string;
  /** The numeric code. Cast-gate findings use a private 9000x range — read {@link syn}, not the number. */
  code:     number;
  message:  string;
  file?:    string;
  line?:    number;
  col?:     number;
  /** Caret-anchored source frame. */
  frame?:   string;
  related?: string[];
  hint?:    string;
  /** A structural cast-gate finding (a rule of this harness) rather than a `tsc` error. */
  syn?:     true;
  /** The annotated block for display: message, frame, related locations and hint. */
  rendered: string;
}

/**
 * The outcome of a {@link ToolTypeIndex.check}. `ok` is `total === 0`.
 *
 * Detail is capped, because a cascade of errors must not become the bulk of a turn's context — but the
 * cap is expressed as data, not smuggled in as a prose element of the findings array. It was appended as
 * one: `diagnostics.length` then counted a summary line as a finding, and any per-code breakdown derived
 * by iterating the array was wrong wherever an overflow had occurred.
 */
export interface ToolCheckReport {
  ok:           boolean;
  /**
   * Whether a check actually RAN. It qualifies `ok`: `ok: true` with `checked: false` means nothing was
   * examined, not that the source is sound — an index that cannot type-check (the browser, which has no
   * TypeScript program) reports exactly that.
   *
   * Required, not optional, because the alternative is the failure this whole path is built to avoid: a
   * checker that reports success while checking nothing is indistinguishable from one that works, and a
   * caller recording "verified" off the back of it records something false.
   */
  checked:      boolean;
  /** Every finding, including those not detailed below — the number to report. */
  total:        number;
  /** The detailed findings, capped. */
  diagnostics:  ToolCheckDiagnostic[];
  /** Present only when the cap hid some, tallied by the same `label` the detailed ones carry. */
  omitted?:     { count: number; byLabel: Record<string, number> };
  /**
   * The {@link ToolTypeIndex.environment} fingerprint this verdict was reached under — what the check
   * depended on besides the snippet and the live tool types. A caller that PERSISTS a verdict stores it
   * beside the source and compares it (string equality, never parsed) against the index's current one,
   * so "this passed" can say which environment it passed in. Absent when nothing was checked.
   */
  environment?: string;
}

/**
 * A {@link ToolCheckReport} as the text an author — usually a model repairing its own code — reads:
 * each finding's annotated block, then the overflow summary as a TRAILING LINE.
 *
 * Here rather than in the checker because two packages render one report: the node checker that
 * produces it, and any consumer that must put it in front of whoever wrote the code. The overflow line
 * is the reason it is worth sharing at all — appending it to the findings ARRAY instead is exactly the
 * bug this shape exists to prevent, and one renderer is one place for that to stay true.
 */
export function renderToolCheck(report: ToolCheckReport): string {
  const parts = report.diagnostics.map(d => d.rendered);
  if (report.omitted !== undefined) parts.push(renderToolCheckOmitted(report.omitted));
  return parts.join('\n');
}

/** The overflow summary alone — one line, for a consumer laying the findings out itself. Separate so it
 *  can be had without rendering every finding in order to keep the last line of the result. */
export function renderToolCheckOmitted(omitted: NonNullable<ToolCheckReport['omitted']>): string {
  const tally = Object.entries(omitted.byLabel).map(([l, n]) => `${l}×${n}`).join(', ');
  // The cascade advice is about tsc's own errors: a cast-gate finding is a structural rule fired at one
  // site, cascades from nothing, and inviting a reader to expect it to vanish with the first fix is what
  // would get it ignored.
  const cascade = Object.keys(omitted.byLabel).some(l => l.startsWith('TS'))
    ? ' — likely cascading from the errors above.' : '';
  return `…plus ${omitted.count} more: ${tally}${cascade}`;
}

/**
 * Optional, node-only developer-experience service: the live `.d.ts` of the types the loaded tools
 * expose — what `toolResult(invokeTool(…, name, …))`, or a `function-tools` `await tool.name(…)`, resolves
 * to — derived by compiling each loaded plugin's `declare module '@matatbread/matbot-plugin-api'`
 * augmentations. The runtime registry can't supply this (result types are erased); only a TypeScript
 * program reading the source can. Consumers that generate or compose tool-calling code use it so the model
 * isn't guessing return shapes. Absent where no TypeScript program can run (the browser today) — a consumer
 * must degrade (guess-and-run) when `services.ToolTypeIndex` is undefined.
 *
 * The result is rebuilt lazily and cached, invalidated when the tool set changes. Tools the source scan
 * can't reach (a `function-tools` function) contribute their types by declaring a `toolContract` string on
 * their registered {@link Tool} — identical in shape to a `ToolContracts` arm; the index splices it off the
 * live registry, so no separate registration step is needed.
 */
export interface ToolTypeIndex {
  /** Self-contained type declarations as a `.d.ts` string: the source-derived `ToolContracts` augmentations
   *  merged with the arms of every other live tool, plus `declare const tool: ToolProxy` — the overloaded
   *  proxy a generator writes `await tool.x(params)` against. */
  dts(): Promise<string>;
  /** Type-check a TypeScript `snippet` against exactly the {@link dts} above — the `tool` proxy ({@link
   *  ToolProxy}: each multi-action tool an overload set, so `await tool.x(params)` narrows its result by the
   *  params) is in scope. Returns a {@link ToolCheckReport} whose positions are snippet-relative. A
   *  composer uses it to catch bad tool-call code before running/registering it. */
  check(snippet: string): Promise<ToolCheckReport>;
  /** Per live tool (that has a contract): the `params`/`result` wire text, flattened from the one contract —
   *  a source tool's `ToolContracts` arms (via the source scan) or a source-less tool's `toolContract` string.
   *  The single contract is thus also the source of the wire description; the host folds this into the
   *  outgoing tool descriptions at the turn's dispatch edge. A tool with only a loose `inputSchema` (no
   *  contract) is absent. */
  wireContracts(): Promise<Record<string, { params: string; result: string }>>;
  /**
   * A fingerprint of everything a {@link check} verdict depends on APART from the snippet and the live
   * tool types — in practice the `FunctionRunner` that will run the code: whether there is one, what it
   * permits a body to import, and which globals it does not bind. Opaque: a consumer compares it for
   * equality and never parses it.
   *
   * It exists because a stored verdict is a claim about an environment, and the environment can be
   * swapped out from under it — unload the runner plugin, or narrow its permitted imports, and a body
   * that passed stays marked as having passed while its `import(…)` is no longer gated, or no longer
   * allowed at all. The tool types are deliberately NOT in it: those are live and `check` is how a
   * caller re-verifies against them, whereas this names the thing a re-check cannot be prompted by.
   *
   * Stable across restarts, so never identity-derived, and derived at the point of use like everything
   * else read off the runner — there is nothing here to invalidate or subscribe to.
   *
   * Optional, because an index written before it existed must degrade rather than throw: a caller with
   * no fingerprint stores none, and compares nothing.
   */
  environment?(): Promise<string>;
}
