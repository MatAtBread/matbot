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
  /** True for a cast-gate finding (a structural rule, not a tsc error) — rendered as CAST, not TSnnnn. */
  syn?:        boolean;
}

// Hints keyed on error code plus (optionally) a pattern over the offending source line or message —
// the pattern is what makes them directed rather than generic. Kept few and high-confidence: a wrong
// hint is worse than none.
const HINTS: { codes: number[]; pattern?: RegExp; hint: string }[] = [
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
    codes: [1484, 1485],
    hint: 'verbatimModuleSyntax: types must be imported with `import type { … }`; values with a plain `import`.',
  },
  {
    codes: [2375, 2379, 2412],
    hint: 'exactOptionalPropertyTypes: never assign undefined to an optional property — omit the key instead, e.g. ...(v !== undefined ? { k: v } : {}).',
  },
  {
    codes: [2307],
    hint: "only '@matatbread/matbot-plugin-api' is importable here; there are no other modules.",
  },
  {
    codes: [2305],
    pattern: /@matatbread\/matbot-plugin-api/,
    hint: 'the package exports only the plugin API surface (ToolContract, ToolResultOf, ToolExecutor, ToolEvent, ToolContext, MatbotPluginSpec, MatbotMachine, makeToolBox, PLUGIN_API_VERSION). Types that appear inside tool contracts (SkillSummary, Trigger, …) are ambient in the tool dts and must NOT be imported — remove them from the import list and let inference carry the values (const r = await tool.x(...)), or inline the structural shape where you need a name.',
  },
  {
    codes: [2304, 2552],
    pattern: /\b(ToolContract|ToolResultOf|ToolExecutor|ToolEvent|ToolContext|MatbotPluginSpec|MatbotMachine|makeToolBox|PLUGIN_API_VERSION)\b/,
    hint: "this name IS a real export of '@matatbread/matbot-plugin-api' — add it to the `import`/`import type { … }` list at the top of the file. Ignore any \"Did you mean\" suggestion pointing at a different name.",
  },
];

function hintFor(d: DiagnosticRecord): string | undefined {
  for (const h of HINTS) {
    if (!h.codes.includes(d.code)) continue;
    if (h.pattern && !h.pattern.test(d.sourceLine ?? '') && !h.pattern.test(d.message)) continue;
    return h.hint;
  }
  return undefined;
}

const MAX_FULL = 8;

function formatOne(d: DiagnosticRecord): string {
  const loc = d.file !== undefined ? `${d.file}(${d.line},${d.col})`
    : d.line !== undefined ? `line ${d.line}` : '(project)';
  const parts = [`${loc} ${d.syn ? 'CAST-GATE' : `TS${d.code}`}: ${d.message}`];
  if (d.frame !== undefined) parts.push(d.frame);
  if (d.related) for (const r of d.related) parts.push(`  related: ${r}`);
  const hint = hintFor(d);
  if (hint !== undefined) parts.push(`  HINT: ${hint}`);
  return parts.join('\n');
}

function overflowNote(diags: DiagnosticRecord[]): string {
  const byCode = new Map<number, number>();
  for (const d of diags.slice(MAX_FULL)) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  return `…plus ${diags.length - MAX_FULL} more: ${[...byCode.entries()].map(([c, n]) => `TS${c}×${n}`).join(', ')} — likely cascading from the errors above.`;
}

async function runWorker(data: Record<string, unknown>): Promise<DiagnosticRecord[] | null> {
  const { Worker } = await import('node:worker_threads');
  const { createRequire } = await import('node:module');
  const typescriptPath = createRequire(import.meta.url).resolve('typescript');

  const result = await new Promise<{ ok?: boolean; diagnostics?: DiagnosticRecord[]; error?: string }>((resolve, reject) => {
    const w = new Worker(TS_WORKER_JS, { eval: true, workerData: { ...data, typescriptPath } });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error('typecheck worker timed out')); }, 120_000);
    w.once('message', m => { clearTimeout(timer); resolve(m as never); void w.terminate(); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
    w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`typecheck worker exited with ${code}`)); });
  });

  if (result.error !== undefined) throw new Error(result.error);
  return result.ok ? null : (result.diagnostics ?? []);
}

/** Typecheck a compiled plugin's build dir against its own tsconfig. `output` is the full annotated
 *  report (anchored frames, related locations, hints, cascade-capped). */
export async function checkProjectDir(buildDir: string): Promise<CheckResult> {
  const diags = await runWorker({ mode: 'project', buildDir });
  if (diags === null) return { ok: true, output: '' };
  const parts: string[] = [];
  if (diags.length > 1) parts.push(`${diags.length} errors. Fix the FIRST error first — later errors often cascade from it.\n`);
  for (const d of diags.slice(0, MAX_FULL)) { parts.push(formatOne(d)); parts.push(''); }
  if (diags.length > MAX_FULL) parts.push(overflowNote(diags));
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
}): Promise<string[]> {
  const diags = await runWorker({
    mode: 'snippet',
    root: opts.root,
    source: opts.source,
    prefixLen: opts.prefixLen,
    prefixLines: opts.prefixLines,
    virtualPath: `${opts.root}/__mb_toolcheck_${crypto.randomUUID()}.ts`,
    ...(opts.apiIndexPath !== undefined ? { apiIndexPath: opts.apiIndexPath } : {}),
  });
  if (diags === null) return [];
  const out = diags.slice(0, MAX_FULL).map(formatOne);
  if (diags.length > MAX_FULL) out.push(overflowNote(diags));
  return out;
}

// The worker body: plain CommonJS (Worker eval mode is CJS, so `require` exists and no loader hooks
// are needed — the host's .ts strip-hooks do not reliably reach worker threads). It loads the SAME
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
    if (workerData.apiIndexPath) options.paths = { '@matatbread/matbot-plugin-api': [workerData.apiIndexPath] };
    const host = ts.createCompilerHost(options);
    const getSF = host.getSourceFile.bind(host);
    host.getSourceFile = function (f, lang, onErr, create) {
      return f === virtual ? ts.createSourceFile(f, source, lang, true) : getSF(f, lang, onErr, create);
    };
    const fe = host.fileExists.bind(host); host.fileExists = function (f) { return f === virtual || fe(f); };
    const rf = host.readFile.bind(host);   host.readFile   = function (f) { return f === virtual ? source : rf(f); };
    program = ts.createProgram([virtual], options, host);
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
  for (const gf of gateFiles) visit(gf, gf);

  const errors = targets.filter(function (d) { return d.category === ts.DiagnosticCategory.Error; }).concat(synth);
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
