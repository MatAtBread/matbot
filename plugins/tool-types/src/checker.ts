// The one TypeScript checker for LLM-generated code: the compiler API run in a worker thread
// (synchronous + CPU-bound, so never on the main loop — a check on the main thread freezes every
// frontend for its whole duration), returning STRUCTURED diagnostics formatted into anchored, hinted
// error text a code-generating model can act on in one pass. Two entry modes over one worker:
//   checkProjectDir     — a compiled plugin's build dir (tsconfig-driven), used by skills_compiler
//   checkSnippetAgainst — a virtual file (ambient dts prefix + snippet), used by ToolTypeIndex.check
//                         to grade function-tools lambdas, with all positions snippet-relative
// There is deliberately NO fallback path: the inputs are fully determined (our own scaffold or our
// own virtual file, the same resolved typescript module), so a checker failure is a plumbing bug
// that must surface as the caller's error, not be absorbed by a quieter path.

import { renderToolCheckOmitted } from '@matatbread/matbot-plugin-api';
import type { ToolCheckDiagnostic, ToolCheckReport } from '@matatbread/matbot-plugin-api';

export interface CheckResult { ok: boolean; output: string }

interface DiagnosticRecord {
  code:        number;
  message:     string;
  file?:       string;
  line?:       number;
  col?:        number;
  frame?:      string;
  sourceLine?: string;
  related?:    string[];
  /** True for a structural-rule finding (not a tsc error) — labelled by {@link SYN_LABELS}, not TSnnnn. */
  syn?:        boolean;
}

// Hints keyed on error code plus (optionally) a pattern over the offending source line or message —
// the pattern is what makes them directed rather than generic. Kept few and high-confidence: a wrong
// hint is worse than none.
//
// `only` is which entry MODE an entry is true in, and it is load-bearing rather than tidy. A compiled
// plugin is a module: it has a top of file to add an import to, `@matatbread/matbot-plugin-api` is a real
// dependency of its build dir, and nothing else is importable. A `tool_function` body is
// `async function __fn(…) { … }`: no top of file, no static imports, and a different importable set
// entirely — whatever this installation permits. These were written for the first and fired in both, so
// a body that mistyped `node:fs` was told there are no modules here.
const HINTS: { codes: number[]; pattern?: RegExp; only?: 'project' | 'snippet'; hint: string }[] = [
  {
    codes: [2739, 2322],
    pattern: /ReturnType\s*<\s*typeof\s+tool\./,
    hint: "an overload set does not narrow through ReturnType. Type the variable ToolResultOf<'<tool_name>'> (the union across the tool's arms, narrowed with a runtime guard before use), or assign the call directly: const r = await tool.<name>({ action: '...' }).",
  },
  {
    codes: [2769, 2345],
    pattern: /\btool\.\w+\s*\(/,
    hint: 'the params must match exactly one arm of this tool\'s contract — check the action value and the required keys against the declared tool contracts.',
  },
  {
    codes: [2532, 18048, 2531],
    hint: 'noUncheckedIndexedAccess: an indexed access (array[i], record[key]) is T | undefined — guard it (if (v !== undefined) …) before use.',
  },
  {
    codes: [2322, 2345],
    pattern: /\| undefined' is not assignable/,
    hint: 'the value may be undefined — often an indexed access (array[i], record[key]) under noUncheckedIndexedAccess. Guard it (if (v !== undefined) …) rather than asserting.',
  },
  {
    codes: [90003],
    pattern: /Object\.(?:keys|values|entries|assign)\s*\(/,
    hint: "Object.keys/values/entries already accept a precisely-typed object — drop the cast and pass the value itself. (If you wanted the key names as a type, that is `keyof typeof x`.)",
  },
  {
    codes: [1484, 1485],
    hint: 'verbatimModuleSyntax: types must be imported with `import type { … }`; values with a plain `import`.',
  },
  {
    codes: [2375, 2379, 2412],
    hint: 'exactOptionalPropertyTypes: never assign undefined to an optional property — omit the key instead, e.g. ...(v !== undefined ? { k: v } : {}).',
  },
  {
    codes: [2307],
    only: 'project',
    hint: "only '@matatbread/matbot-plugin-api' is importable here; there are no other modules.",
  },
  {
    codes: [2307],
    only: 'snippet',
    // No list: the declarations above already carry one, derived from the same permitted set, and a
    // second copy here would be the thing that goes stale. What this adds is WHY a specifier can be
    // absent, since "not permitted" and "has no declarations" are repaired differently.
    hint: 'this module is not typed here. The comment block at the top of these declarations says what this installation permits; a node builtin has real types (either spelling: `node:os` or `os`), while a bare package or an http(s) URL has none, and importing one of those needs noTypeCheck.',
  },
  {
    codes: [2305],
    only: 'project',
    pattern: /@matatbread\/matbot-plugin-api/,
    hint: 'the package exports only the plugin API surface (ToolContract, ToolResultOf, ToolExecutor, ToolEvent, ToolContext, MatbotPluginSpec, MatbotMachine, makeToolBox, PLUGIN_API_VERSION). Types that appear inside tool contracts (SkillSummary, Trigger, …) are ambient in the tool dts and must NOT be imported — remove them from the import list and let inference carry the values (const r = await tool.x(...)), or inline the structural shape where you need a name.',
  },
  {
    codes: [2304, 2552],
    only: 'project',
    pattern: /\b(ToolContract|ToolResultOf|ToolExecutor|ToolEvent|ToolContext|MatbotPluginSpec|MatbotMachine|makeToolBox|PLUGIN_API_VERSION)\b/,
    hint: "this name IS a real export of '@matatbread/matbot-plugin-api' — add it to the `import`/`import type { … }` list at the top of the file. Ignore any \"Did you mean\" suggestion pointing at a different name.",
  },
];

type Mode = 'project' | 'snippet';

function hintFor(d: DiagnosticRecord, mode: Mode): string | undefined {
  for (const h of HINTS) {
    if (!h.codes.includes(d.code)) continue;
    if (h.only !== undefined && h.only !== mode) continue;
    if (h.pattern && !h.pattern.test(d.sourceLine ?? '') && !h.pattern.test(d.message)) continue;
    return h.hint;
  }
  return undefined;
}

const MAX_FULL = 8;

// A structural rule's label, by its private code. CAST-GATE is the default because it was the first and
// is what the contract gate (90004) has always reported as; a rule about something other than types
// needs its own name, or the label says the wrong thing about the finding under it.
const SYN_LABELS: Record<number, string> = { 90005: 'ENV-GATE', 90006: 'IMPORT-GATE' };

// One rule, one name, in every renderer: a per-rule label read off the record rather than spelled at
// each render site, so a summary can never call a finding something its own entry did not.
function label(d: DiagnosticRecord): string {
  return d.syn ? (SYN_LABELS[d.code] ?? 'CAST-GATE') : `TS${d.code}`;
}

function formatOne(d: DiagnosticRecord, mode: Mode): string {
  const loc = d.file !== undefined ? `${d.file}(${d.line},${d.col})`
    : d.line !== undefined ? `line ${d.line}` : '(project)';
  const parts = [`${loc} ${label(d)}: ${d.message}`];
  if (d.frame !== undefined) parts.push(d.frame);
  if (d.related) for (const r of d.related) parts.push(`  related: ${r}`);
  const hint = hintFor(d, mode);
  if (hint !== undefined) parts.push(`  HINT: ${hint}`);
  return parts.join('\n');
}

// The findings the cap hides, tallied by the same `label` the detailed ones carry.
function omittedOf(diags: DiagnosticRecord[]): { count: number; byLabel: Record<string, number> } | undefined {
  const hidden = diags.slice(MAX_FULL);
  if (hidden.length === 0) return undefined;
  const byLabel: Record<string, number> = {};
  for (const d of hidden) byLabel[label(d)] = (byLabel[label(d)] ?? 0) + 1;
  return { count: hidden.length, byLabel };
}

/**
 * The worker's records as the service's {@link ToolCheckReport}: structured findings, the cap expressed
 * as `omitted` data, and each finding's annotated rendering carried on the record itself.
 *
 * The rendering used to be the WHOLE return value — one `string[]` of formatted blocks with the overflow
 * summary appended as a further element. So `diagnostics.length` counted prose as a finding, and any
 * per-code breakdown taken by iterating the array was unreliable wherever an overflow had occurred.
 * The typed record existed upstream all along and was discarded at render time; it is kept now, and the
 * text is one field of it.
 */
function reportOf(diags: DiagnosticRecord[], mode: Mode): ToolCheckReport {
  const omitted = omittedOf(diags);
  const detailed: ToolCheckDiagnostic[] = diags.slice(0, MAX_FULL).map(d => ({
    label:   label(d),
    code:    d.code,
    message: d.message,
    ...(d.file    !== undefined ? { file:    d.file    } : {}),
    ...(d.line    !== undefined ? { line:    d.line    } : {}),
    ...(d.col     !== undefined ? { col:     d.col     } : {}),
    ...(d.frame   !== undefined ? { frame:   d.frame   } : {}),
    ...(d.related !== undefined ? { related: d.related } : {}),
    ...(hintFor(d, mode) !== undefined ? { hint: hintFor(d, mode)! } : {}),
    ...(d.syn === true ? { syn: true as const } : {}),
    rendered: formatOne(d, mode),
  }));
  return {
    ok:      diags.length === 0,
    checked: true,
    total:   diags.length,
    diagnostics: detailed,
    ...(omitted !== undefined ? { omitted } : {}),
  };
}

async function runWorker(data: Record<string, unknown>): Promise<DiagnosticRecord[] | null> {
  const { Worker } = await import('node:worker_threads');
  const { createRequire } = await import('node:module');
  const typescriptPath = createRequire(import.meta.url).resolve('typescript');

  const result = await new Promise<{ ok?: boolean; diagnostics?: DiagnosticRecord[]; error?: string }>((resolve, reject) => {
    // Parsed AS TypeScript, never left to node to guess: without the flag eval'd code runs as JS and is
    // retried as TS only if it fails to parse, and `new Set<string>(x)` parses fine as two comparisons —
    // so it would have thrown `string is not defined` but for an unrelated annotation elsewhere in the
    // source happening to be a JS syntax error. It REPLACES the inherited flags rather than adding to
    // them: node refuses process-wide ones in a worker's execArgv (the test runner passes several), and
    // the worker needs none of them — it loads no hooks, by design.
    const w = new Worker(TS_WORKER_JS, {
      eval: true, workerData: { ...data, typescriptPath },
      execArgv: ['--input-type=commonjs-typescript'],
    });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error('typecheck worker timed out')); }, 120_000);
    w.once('message', m => { clearTimeout(timer); resolve(m as never); void w.terminate(); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
    w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`typecheck worker exited with ${code}`)); });
  });

  if (result.error !== undefined) throw new Error(result.error);
  return result.ok ? null : (result.diagnostics ?? []);
}

/**
 * Typecheck a compiled plugin's build dir against its own tsconfig. `output` is the full annotated
 * report (anchored frames, related locations, hints, cascade-capped).
 *
 * `ownContracts` names the tools this compilation is entitled to declare a `ToolContracts` arm for — its
 * own. Any other arm in the checked source is rejected like a cast: the dts is an input to generation,
 * derived from the live registry, so an arm authored here asserts a shape nothing can contradict. Omit
 * the option and the rule does not run (there is then no way to tell a self-declaration from an invention).
 */
export async function checkProjectDir(
  buildDir: string, opts?: { ownContracts?: readonly string[] },
): Promise<CheckResult> {
  const diags = await runWorker({
    mode: 'project', buildDir,
    ...(opts?.ownContracts !== undefined ? { ownContracts: [...opts.ownContracts] } : {}),
  });
  if (diags === null) return { ok: true, output: '' };
  const report = reportOf(diags, 'project');
  const parts: string[] = [];
  if (report.total > 1) parts.push(`${report.total} errors. Fix the FIRST error first — later errors often cascade from it.\n`);
  for (const d of report.diagnostics) { parts.push(d.rendered); parts.push(''); }
  if (report.omitted !== undefined) parts.push(renderToolCheckOmitted(report.omitted));
  return { ok: false, output: parts.join('\n').trim() };
}

/** Typecheck a snippet against an ambient prefix (the derived tool dts) as one virtual module rooted
 *  at `root`. Returns one annotated block per diagnostic, positions snippet-relative — the shape
 *  {@link ToolTypeIndex.check} has always returned, upgraded from bare `line N: message` strings. */
export async function checkSnippetAgainst(opts: {
  root:          string;
  source:        string;
  prefixLen:     number;
  prefixLines:   number;
  apiIndexPath?: string;
  /** `paths` entries for the module specifiers this installation permits a body to import — one per
   *  permitted module, so a module outside the set does not resolve and is a compile error rather than
   *  something that typechecks and is refused at run time. Built by the caller, which knows the set. */
  importPaths?: Record<string, string[]>;
  /** Declaration files for the globals a body HAS beyond the standard library, loaded as roots: on node,
   *  `Buffer`. Module types arrive only through {@link importPaths}, which load on an import, so a body
   *  using a node global without importing anything would otherwise fail on a name it really has. */
  globalTypes?: readonly string[];
  /** The restriction itself, when there is one — `paths` cannot enforce it. Loading ONE builtin's
   *  declaration file pulls in the ambient `declare module 'node:…'` blocks of everything its own
   *  declarations reference (`node:fs` reaches `node:stream`, which reaches most of the rest), so a
   *  forbidden specifier resolves anyway and typechecks clean. A literal `import('…')` is therefore
   *  checked STRUCTURALLY against this list, the way the cast gate and ENV-GATE close the other holes
   *  the type system cannot. Absent ⇒ unrestricted, and nothing is checked. */
  permittedImports?: readonly string[];
  /** The identifiers the RUNNER does not bind, from `FunctionRunner.withheldGlobals` — the list ENV-GATE
   *  rejects. It comes from the runner because a copy here could not be kept in step with it, and a name
   *  that is shadowed but not rejected typechecks and then fails at the first call. Absent ⇒ nothing is
   *  rejected: with no runner there is no claim about what a body does not have. */
  withheldGlobals?: readonly string[];
}): Promise<ToolCheckReport> {
  const diags = await runWorker({
    mode: 'snippet',
    root: opts.root,
    source: opts.source,
    prefixLen: opts.prefixLen,
    prefixLines: opts.prefixLines,
    virtualPath: `${opts.root}/__mb_toolcheck_${crypto.randomUUID()}.ts`,
    ...(opts.apiIndexPath !== undefined ? { apiIndexPath: opts.apiIndexPath } : {}),
    ...(opts.importPaths  !== undefined ? { importPaths:  opts.importPaths  } : {}),
    ...(opts.globalTypes  !== undefined ? { globalTypes:  opts.globalTypes  } : {}),
    ...(opts.permittedImports !== undefined ? { permittedImports: opts.permittedImports } : {}),
    ...(opts.withheldGlobals !== undefined ? { withheldGlobals: opts.withheldGlobals } : {}),
  });
  return reportOf(diags ?? [], 'snippet');
}

// The worker body: CommonJS (Worker eval mode is CJS, so `require` exists and no loader hooks are
// needed — the host's .ts strip-hooks do not reliably reach worker threads). Type annotations are
// fine here because the worker is started with `--input-type=commonjs-typescript`, so node strips them
// rather than guessing whether the source is TS (see runWorker). Anything beyond erasable syntax is not —
// no enums, no parameter properties. It loads the SAME
// typescript module the main thread resolved and posts back JSON-safe records: flattened message
// chains, related-information locations (e.g. which contract arm an expected type came from), and a
// caret-anchored source frame per error. In snippet mode every position is remapped to be
// snippet-relative (the ambient dts prefix is invisible to the caller) and prefix-internal
// diagnostics are dropped — a broken derived dts is our bug, not the snippet's.
const TS_WORKER_JS = `
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
try {
  const ts = require(workerData.typescriptPath);
  let targets, virtual = null, lineOffset = 0, baseDir, program, gateFiles = [], minStart = 0;

  if (workerData.mode === 'project') {
    baseDir = workerData.buildDir;
    const configPath = path.join(baseDir, 'tsconfig.json');
    const host = Object.assign({}, ts.sys, {
      onUnRecoverableConfigFileDiagnostic: function (d) {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' '));
      },
    });
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (!parsed) throw new Error('could not parse ' + configPath);
    program = ts.createProgram({ rootNames: parsed.fileNames, options: Object.assign({}, parsed.options, { noEmit: true }) });
    targets = []
      .concat(program.getConfigFileParsingDiagnostics())
      .concat(program.getOptionsDiagnostics())
      .concat(program.getSyntacticDiagnostics())
      .concat(program.getGlobalDiagnostics())
      .concat(program.getSemanticDiagnostics());
    gateFiles = program.getSourceFiles().filter(function (f) {
      return !f.isDeclarationFile
        && f.fileName.indexOf('node_modules') === -1
        && !path.relative(baseDir, f.fileName).startsWith('..');
    });
  } else {
    baseDir = workerData.root;
    virtual = workerData.virtualPath;
    lineOffset = workerData.prefixLines;
    minStart = workerData.prefixLen;
    const source = workerData.source;
    const options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, baseUrl: baseDir,
    };
    // Module types come in through 'paths', one entry per PERMITTED specifier, never through
    // types:['node'] — which is all-or-nothing (it makes every builtin resolve, so a module the install
    // forbids typechecks clean and is refused only at run time) and pulls 168 files where this pulls 65.
    // The plugin-api entry is needed in BOTH modes, and in snippet mode it is not about a body's imports
    // at all: the generated declarations refer to their own types inline as
    // import('@matatbread/matbot-plugin-api').ToolProxy, so without it every one of them collapses to any
    // and bad snippets pass silently. That a BODY must not import the package is a separate fact,
    // enforced structurally below — it cannot be expressed by withholding the resolution.
    options.paths = {
      ...(workerData.apiIndexPath ? { '@matatbread/matbot-plugin-api': [workerData.apiIndexPath] } : {}),
      ...(workerData.importPaths ?? {}),
    };
    const host = ts.createCompilerHost(options);
    const getSF = host.getSourceFile.bind(host);
    host.getSourceFile = function (f, lang, onErr, create) {
      return f === virtual ? ts.createSourceFile(f, source, lang, true) : getSF(f, lang, onErr, create);
    };
    const fe = host.fileExists.bind(host); host.fileExists = function (f) { return f === virtual || fe(f); };
    const rf = host.readFile.bind(host);   host.readFile   = function (f) { return f === virtual ? source : rf(f); };
    program = ts.createProgram([virtual].concat(workerData.globalTypes ?? []), options, host);
    const sf = program.getSourceFile(virtual);
    targets = sf
      ? [].concat(program.getSyntacticDiagnostics(sf)).concat(program.getSemanticDiagnostics(sf))
          .filter(function (d) { return typeof d.start === 'number' && d.start >= minStart; })
      : [];
    if (sf) gateFiles = [sf];
  }

  // ── cast gate: structural rules over the generated source, reported as synthetic diagnostics ──
  // tsc accepts type assertions unconditionally, so a generated tool can re-assert a shape onto a
  // value the proxy already typed precisely — a hallucinated field then compiles and fails silently
  // at runtime. Three rules: 'as any' (always); 'as unknown as T' (laundering); a checker-verified
  // widening of an already-typed value to a loosening target (Record<...>, object, unknown, or an
  // index-signature-only literal) — the first step of the widen-then-reassert pattern. Assertions on
  // genuinely-unknown sources (the executor's input, await resp.json(), catch variables) pass, as do
  // narrowing assertions and 'as const'.
  const checker = program.getTypeChecker();
  const synth = [];
  const isLoosening = function (t) {
    if (!t) return false;
    if (t.kind === ts.SyntaxKind.UnknownKeyword || t.kind === ts.SyntaxKind.ObjectKeyword) return true;
    if (ts.isTypeReferenceNode(t) && t.typeName.getText() === 'Record') return true;
    if (ts.isTypeLiteralNode(t) && t.members.length > 0 && t.members.every(function (m) { return ts.isIndexSignatureDeclaration(m); })) return true;
    return false;
  };
  const mk = function (sf, node, code, msg) {
    return { file: sf, start: node.getStart(sf), length: node.getWidth(sf), code: code,
             category: ts.DiagnosticCategory.Error, messageText: msg, __syn: true };
  };
  // ── contract gate: a generated tool declares its OWN ToolContracts arm and nobody else's ──
  // The dts is an INPUT to code generation, derived from the live registry. A generated file that adds an
  // arm for another tool is not describing anything — it is asserting a shape tsc then has no way to
  // contradict, so a wrong guess compiles and fails at runtime. Measured, when the derived dts was
  // unavailable and the model wanted \`whoami\`: it declared \`ToolContract<{ id: string; type: string }, {}>\`
  // for it, which compiled clean and only resembled the real \`Principal\`. The cast gate cannot see this —
  // nothing is cast. Only enforced when the caller says which names are the compilation's own; absent that
  // list the rule cannot tell an invention from a legitimate self-declaration, so it does not run.
  const own = Array.isArray(workerData.ownContracts) ? workerData.ownContracts : null;
  const contractVisit = function (node, sf) {
    if (own && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)
        && node.name.text === '@matatbread/matbot-plugin-api' && node.body && node.getStart(sf) >= minStart) {
      node.body.forEachChild(function (decl) {
        if (!ts.isInterfaceDeclaration(decl) || decl.name.text !== 'ToolContracts') return;
        for (const member of decl.members) {
          const name = member.name && member.name.getText ? member.name.getText(sf) : '';
          if (name === '' || own.indexOf(name) !== -1) continue;
          synth.push(mk(sf, member, 90004,
            "the contract for '" + name + "' is not yours to declare — tool contracts come from the ambient " +
            "tool dts, which is derived from the live registry. Declaring one here asserts a shape nothing " +
            "can check, so a wrong guess compiles and fails at runtime. Delete this member: call the tool as " +
            "'await tool." + name + "(...)' and use the value it returns, whose type is already precise. If '" +
            name + "' is absent from the ambient dts then no such tool is loaded and it cannot be called at all."));
        }
      });
    }
    ts.forEachChild(node, function (c) { contractVisit(c, sf); });
  };

  // ── env gate: a global that TypeScript resolves but the runner does not define ──
  // A tool_function body is compiled as a bare async function expression, not a module and not a CJS
  // wrapper, so 'require', 'module', 'exports', '__dirname' and '__filename' are all undefined at
  // runtime and 'import.meta' will not even compile. Loading node's types to check await import('node:…')
  // declares every one of them as a global, which makes the commonest wrong guess — require('node:fs') —
  // typecheck clean and fail at the first call: correct against the types it was shown, so the repair loop
  // cannot repair it. Rejected structurally for the same reason a cast is, with the working form named.
  // Only in snippet mode: a compiled plugin IS a module and legitimately has 'import.meta'.
  //
  // WHICH names are withheld comes from the runner's withheldGlobals, because it is the only thing that
  // knows and a copy here could not be kept in step: a name shadowed but not rejected typechecks and
  // fails at the first call, which is the one failure this gate exists to prevent. 'eval' and 'Function'
  // are the worst to miss, being lib.es globals that typecheck in every configuration.
  //
  // The ADVICE stays here, because it is about repairing a snippet and that is this file's job, not the
  // runner's. A withheld name with no entry below still fires, with a generic line — the list is the
  // runner's to grow, and a new one must not pass silently for want of prose.
  const ADVICE: Record<string, string> = {
    require:    "'require' is not defined in a function body — it is compiled as a bare async function, not a module. Use a dynamic import instead: 'const fs = await import('node:fs/promises')'.",
    module:     "'module' is not defined in a function body — it is compiled as a bare async function, not a CommonJS module. Return a value instead of assigning to an export.",
    exports:    "'exports' is not defined in a function body — it is compiled as a bare async function, not a CommonJS module. Return a value instead of assigning to an export.",
    __dirname:  "'__dirname' is not defined in a function body, and neither is 'process' — a body computes and calls tools, it does not navigate the filesystem by hand. 'context.workdir' is the directory a call was given, when it was given one.",
    __filename: "'__filename' is not defined in a function body. There is no file — the body is compiled from source held in the session.",
    process:    "'process' is not defined in a function body — the runner withholds it, so there is no 'process.env', 'process.cwd()' or 'process.getBuiltinModule()'. A module comes from a gated 'await import('node:…')', and 'context.workdir' is the directory a call was given.",
    globalThis: "'globalThis' is not defined in a function body — the runner withholds it, so a host global cannot be reached by name. Everything a body is given is already in scope: 'tool', 'toolInContext' and 'context'.",
    global:     "'global' is not defined in a function body — the runner withholds it, and it is node's older alias for 'globalThis', which is withheld too. Everything a body is given is already in scope: 'tool', 'toolInContext' and 'context'.",
    eval:       "'eval' is not defined in a function body — the runner withholds it. There is nothing to evaluate at run time: write the code, or call another tool with 'await tool.<name>(…)'.",
    Function:   "'Function' is not defined in a function body — the runner withholds the constructor, so 'new Function(…)' cannot build code at run time. Write the code directly. (As a TYPE annotation it is fine; this is about the value.)",
  };
  // A withheld global named in a TYPE is harmless: types are erased before the body is compiled, so
  // 'args: Buffer' never reaches the runner. Only the VALUE is rejected. Needed because the second half of
  // the list above — unlike 'require' and friends — are types as well as values.
  const inTypePosition = function (node) {
    for (let a = node.parent; a; a = a.parent) {
      if (ts.isTypeNode(a)) return true;
      if (ts.isBlock(a) || ts.isSourceFile(a)) return false;
    }
    return false;
  };
  const envGate = workerData.mode === 'snippet';
  // Where the rule fired, so tsc's own 'Cannot find name' for the same identifier can be dropped: without
  // node's types loaded both report, and two findings for one fix read as a cascade when the second says
  // nothing the first did not — except which repair to make, which is the one this rule carries.
  const envStarts = new Set();
  // Declared by the author rather than inherited from node's globals: their own binding shadows it and
  // works, so the rule must not fire. Decided on where the symbol's declaration IS, not on the parent
  // node kind — that catches 'const require = …', a parameter and an import alias with one test.
  const authorDeclared = function (node) {
    const sym = checker.getSymbolAtLocation(node);
    const decls = sym && sym.declarations;
    if (!decls) return false;
    return decls.some(function (d) {
      return d.getSourceFile().fileName === virtual && d.getStart() >= minStart;
    });
  };
  // The permit's boundary rule and the by-name rule, inlined: the worker is a CommonJS realm with no
  // loader hooks, so it cannot import 'importPermitted' or 'importableByName' from plugin-api, which is
  // where both rules live and are documented.
  const byName = function (spec) {
    return spec !== '' && !/[^\\w@.~+!$&'()*,;=:/-]/.test(spec) && !/^[./]/.test(spec)
      && (spec.indexOf('node:') === 0 || !/^[a-z][a-z0-9+.-]*:/i.test(spec))
      && !spec.split('/').some(function (seg) { return seg === '.' || seg === '..'; });
  };
  // The node runner's canonicalImport, which is what the gate asks about: 'os' is 'node:os', so a
  // restriction of 'node:' admits it at both.
  const isBuiltin = require('node:module').isBuiltin;
  const canonical = function (spec) {
    return spec.indexOf(':') < 0 && isBuiltin(spec) ? 'node:' + spec : spec;
  };
  const permits = workerData.permittedImports;
  const API_PKG = '@matatbread/matbot-plugin-api';
  const withheld = new Set<string>(workerData.withheldGlobals ?? []);
  const permitted = function (spec) {
    return permits.some(function (p) {
      return spec === p
        || (p.charAt(p.length - 1) === '/' || p.charAt(p.length - 1) === ':'
              ? spec.indexOf(p) === 0
              : spec.indexOf(p + '/') === 0);
    });
  };
  // Where an import was reported on by a rule of ours, so tsc's own complaint about the same specifier is
  // dropped. Both fire whenever the module does not resolve, and tsc's is actively misleading here: it
  // offers "Do you need to install type definitions for node?" about a module the INSTALLATION forbids,
  // which is not a thing the author can fix — or, for a specifier that lands on a declaration-only
  // package, a path inside matbot's own node_modules. Which of the three tsc emits depends on whether
  // @types/node happens to be reachable from the program root, so these rules are the deterministic ones.
  const importStarts = new Set();
  // Every literal import()'s specifier and where it sits, recorded whether or not a restriction exists:
  // the rewrite below is about SPELLING, which no permit decides.
  const importSpecs = new Map();
  const envVisit = function (node, sf) {
    if (envGate && node.getStart(sf) >= minStart) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text;
        const at = node.arguments[0].getStart(sf);
        importSpecs.set(at, spec);
        // Resolvable for TYPES (the declarations above refer to it) and not at run time: the runner's
        // import resolves from the CLI's own module, where under pnpm this package is not present. So it
        // typechecked clean and died at the first call — exactly the hole this gate exists to close —
        // and nothing a body needs is in there anyway.
        if (spec === API_PKG || spec.indexOf(API_PKG + '/') === 0) {
          synth.push(mk(sf, node.arguments[0], 90006,
            "'" + spec + "' cannot be imported by a function body: it is in scope for TYPES only. Everything a body is given is already ambient — 'tool', 'toolInContext' and 'context' — so there is nothing to import from it."));
          importStarts.add(at);
        } else if (!byName(spec)) {
          // Whatever the runner: the gate refuses these without asking, so a body naming one is refused
          // at definition rather than at its first call.
          synth.push(mk(sf, node.arguments[0], 90006,
            "'" + spec + "' cannot be imported by a function body, which imports only node builtins ('node:fs') and packages already installed where matbot runs, by name — never a path or a URL. To use other code, install it as a package, or as a matbot plugin with the 'plugin' tool."));
          importStarts.add(at);
        } else if (permits !== undefined && !permitted(canonical(spec))) {
          synth.push(mk(sf, node.arguments[0], 90006,
            permits.length === 0
              ? "module imports are switched off on this installation, so '" + spec + "' cannot be imported. Compute with the tools available instead."
              : "'" + spec + "' is not permitted on this installation, which allows only: " + permits.join(', ')
                + ". This is configuration, not a permission anyone can grant at the call — use a permitted module, or none."));
          importStarts.add(at);
        }
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        synth.push(mk(sf, node, 90005,
          "'import.meta' is only available in a module, and a function body is not one — this is a syntax error when the body is compiled, so it cannot run at all. Remove it."));
      } else if (ts.isIdentifier(node) && withheld.has(node.text)
                 && !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                 && !(node.parent && (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node)
                 // The SOURCE half of a renamed destructuring is a property of the thing being unpacked,
                 // not the global: 'const { Buffer: B } = await import("node:buffer")' is the working
                 // form, and firing on it recommended almost exactly the code it was rejecting. The
                 // shorthand is already exempt by a different route — there the identifier IS the local
                 // declaration, so 'authorDeclared' answers for it.
                 && !(node.parent && ts.isBindingElement(node.parent) && node.parent.propertyName === node)
                 && !inTypePosition(node)
                 && !authorDeclared(node)) {
        synth.push(mk(sf, node, 90005, ADVICE[node.text]
          ?? ("'" + node.text + "' is not defined in a function body — the runner withholds it.")));
        envStarts.add(node.getStart(sf));
      }
    }
    ts.forEachChild(node, function (c) { envVisit(c, sf); });
  };

  const skip = new Set();
  const visit = function (node, sf) {
    const isAssertion = ts.isAsExpression(node) || (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(node));
    if (isAssertion && !skip.has(node) && node.getStart(sf) >= minStart) {
      const target = node.type;
      const inner = node.expression;
      if (target.kind === ts.SyntaxKind.AnyKeyword) {
        synth.push(mk(sf, node, 90001,
          "'as any' is forbidden in generated tools — it disables the type checking that guards this code. Use the value's declared type directly, or narrow with a runtime guard ('field' in x, Array.isArray(x), typeof x === '...')."));
      } else if ((ts.isAsExpression(inner) || (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(inner)))
                 && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
        skip.add(inner);   // one finding per construct — the inner 'as unknown' is part of this one
        synth.push(mk(sf, node, 90002,
          "double assertion ('as unknown as T') launders a type the checker already knows — remove both assertions and narrow with a runtime guard instead."));
      } else if (isLoosening(target)) {
        const f = checker.getTypeAtLocation(inner).flags;
        if (!(f & ts.TypeFlags.Any) && !(f & ts.TypeFlags.Unknown)) {
          synth.push(mk(sf, node, 90003,
            "this expression is already precisely typed — widening it to '" + target.getText(sf) + "' discards the checked structure, so every later read of it is unverifiable. Use the typed value directly, or narrow with a runtime guard."));
        }
      }
    }
    ts.forEachChild(node, function (c) { visit(c, sf); });
  };
  for (const gf of gateFiles) { visit(gf, gf); contractVisit(gf, gf); envVisit(gf, gf); }

  // A bare 'node' is not the builtins namespace — it resolves to @types/node's index.d.ts, which is
  // references and ambient blocks with no export, so tsc reports "File '<matbot's own node_modules>/
  // @types/node/index.d.ts' is not a module": a path the body never named and its author cannot act on.
  // Rewritten only where tsc ALREADY failed on it, so a package genuinely called 'node' is untouched,
  // and only where no gate has spoken at that position, so one mistake stays one finding. It is also what
  // a restriction of ["node"] permits — a package of that name, no builtin — which is why this fires with
  // no restriction in force too.
  for (const d of targets) {
    if (d.code !== 2306 && d.code !== 2307) continue;
    if (importSpecs.get(d.start) !== 'node' || importStarts.has(d.start)) continue;
    synth.push({ file: d.file, start: d.start, length: d.length, code: 90006,
                 category: ts.DiagnosticCategory.Error, __syn: true,
                 messageText: "there is no module called 'node'. Node's builtins carry the 'node:' prefix — import 'node:fs/promises' or 'node:os', naming the one you need." });
    importStarts.add(d.start);
  }

  // ── TS2591's repair is never actionable in a snippet ──
  // "Cannot find name 'process'. Do you need to install type definitions for node? Try 'npm i --save-dev
  // @types/node'" is tsc telling a function body to run a package manager: there is no package.json to
  // install into, and what a body is typed against is fixed by the runner, not by what happens to be
  // installed. It fires for any global node declares that this configuration did not type — most often
  // 'process', which ENV-GATE does not reach when NO runner is loaded, because then nothing is withheld.
  // The finding is right and only the advice is wrong, so the message is replaced and the position
  // suppressed exactly as a withheld name's is. No list of names here, deliberately: the trigger is
  // tsc's own code, so this cannot drift out of step with what the runner withholds.
  if (envGate) {
    for (const d of targets) {
      if (d.code !== 2591 || !d.file || typeof d.start !== 'number') continue;
      if (envStarts.has(d.start) || importStarts.has(d.start)) continue;
      // tsc raises the same code for an import() of a builtin it has no declarations for, at the
      // specifier — which is a module, not a global, and is repaired differently.
      const spec = importSpecs.get(d.start);
      if (spec !== undefined) {
        synth.push({ file: d.file, start: d.start, length: d.length, code: 90006,
                     category: ts.DiagnosticCategory.Error, __syn: true,
                     messageText: "'" + spec + "' has no type declarations here, so nothing it returns can be checked. The comment block at the top of these declarations lists the modules this installation types — use one of those, or define this function with noTypeCheck." });
        importStarts.add(d.start);
        continue;
      }
      const name = d.file.text.substr(d.start, d.length);
      synth.push({ file: d.file, start: d.start, length: d.length, code: 90005,
                   category: ts.DiagnosticCategory.Error, __syn: true,
                   messageText: "'" + name + "' is not declared for a function body: the declarations above are the whole of the environment a body is typed against, and there are no type definitions to install from here. A node builtin comes from an 'await import' of a 'node:…' specifier; everything else a body is given is already in scope — 'tool', 'toolInContext' and 'context'." });
      envStarts.add(d.start);
    }
  }

  const errors = targets.filter(function (d) {
    if (d.category !== ts.DiagnosticCategory.Error) return false;
    if ((d.code === 2306 || d.code === 2307 || d.code === 2591) && importStarts.has(d.start)) return false;
    return !((d.code === 2304 || d.code === 2591) && envStarts.has(d.start));
  }).concat(synth);
  errors.sort(function (a, b) {
    const fa = a.file ? a.file.fileName : '', fb = b.file ? b.file.fileName : '';
    return fa < fb ? -1 : fa > fb ? 1 : (a.start || 0) - (b.start || 0);
  });
  const rec = function (d) {
    const out = { code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\\n    ') };
    if (d.__syn) out.syn = true;
    if (d.file && typeof d.start === 'number') {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      if (d.file.fileName !== virtual) out.file = path.relative(baseDir, d.file.fileName);
      out.line = pos.line + 1 - lineOffset;
      out.col = pos.character + 1;
      const lines = d.file.text.split(/\\r?\\n/);
      const from = Math.max(lineOffset, pos.line - 2);
      const to = Math.min(lines.length - 1, pos.line + 1);
      const frame = [];
      for (let i = from; i <= to; i++) {
        frame.push((i === pos.line ? '>' : ' ') + ' ' + String(i + 1 - lineOffset).padStart(4) + ' | ' + lines[i]);
        if (i === pos.line) frame.push('  ' + ' '.repeat(4) + ' | ' + ' '.repeat(pos.character) + '^');
      }
      out.frame = frame.join('\\n');
      out.sourceLine = lines[pos.line] || '';
    }
    if (d.relatedInformation && d.relatedInformation.length) {
      out.related = d.relatedInformation.map(function (r) {
        let loc = '';
        if (r.file && typeof r.start === 'number') {
          const p = r.file.getLineAndCharacterOfPosition(r.start);
          const name = r.file.fileName === virtual ? 'ambient tool types' : path.basename(r.file.fileName);
          loc = name + '(' + (p.line + 1) + ',' + (p.character + 1) + '): ';
        }
        return loc + ts.flattenDiagnosticMessageText(r.messageText, ' ');
      });
    }
    return out;
  };
  parentPort.postMessage({ ok: errors.length === 0, diagnostics: errors.map(rec) });
} catch (e) {
  parentPort.postMessage({ error: String((e && e.message) || e) });
}
`;
