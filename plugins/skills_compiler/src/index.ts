import { PLUGIN_API_VERSION, currentPrincipal, invokeTool, toolResult, toolText } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext, ToolContract, ToolResultOf, Session, Message } from '@matatbread/matbot-plugin-api';
import { buildMatbotToolsDts, checkProjectDir } from '@matatbread/matbot-tool-types';
import { writePluginScaffold } from './scaffold.js';
// Re-exported for the scaffold's own tests: what it must not assume about where matbot.yaml sits is
// only checkable by building outside a source checkout, which no in-repo compile does.
export { writePluginScaffold, hostPluginApiDir } from './scaffold.js';
// Type-only, for the skills plugin's `MatbotServices.SkillManager` declaration. Erased, and a
// devDependency, so there is no runtime dependency on the package: consumption stays
// `services.SkillManager?.` and degrades when skills isn't loaded. This file used to declare its own
// two-method slice of the key to avoid even the type edge, but a registry key is registered by
// declaration MERGING — two declarations of one key with different types is a TS2717, and the survivor
// was whichever the compiler saw first. Loose at runtime is the goal; disagreeing about the type was
// never part of it.
import type {} from '@matatbread/matbot-skills';

declare module '@matatbread/matbot-plugin-api' {
  // The `skill_compiler` tool's own call contract — a source tool, so its contract is a ToolContracts
  // union (the single source): the executor binds off it (ToolResultOf) and the wire text derives from
  // it. Two actions: `compile` (build/iterate + install) and `inspect` (read the current version).
  interface ToolContracts {
    skill_compiler:
      | ToolContract<
          | { status: 'not_found';    message: string }
          | { status: 'no_metadata';  skill: string; message: string }
          | { status: 'not_compilable'; skill: string; classification: { procedural: number; informational: number } }
          | { status: 'typecheck_failed'; skill: string; toolName: string; version: string; dir: string; passes: number; iterated: boolean; distilled: boolean; method: string; excluded: string[]; typecheckOutput: string }
          | { status: 'compiled_not_installed'; skill: string; toolName: string; pluginName: string; version: string; dir: string; specifier: string; typecheckOk: boolean; iterated: boolean; distilled: boolean; method: string; excluded: string[]; installError: string }
          | { status: 'installed'; skill: string; classification: { procedural: number; informational: number }; passes: number; iterated: boolean; distilled: boolean; toolName: string; pluginName: string; version: string; dir: string; specifier: string; typecheckOk: boolean; method: string; excluded: string[]; install: string; movedTriggers: string[]; hidden: boolean },
          { action?: 'compile'; skill: string; provider?: string; toolName?: string; packageNamePrefix?: string; feedback?: string }
        >
      | ToolContract<
          | { status: 'not_found_on_disk'; toolName: string; dir: string; message: string }
          | { status: 'inspected'; toolName: string; pluginName?: string; version: string; dir: string; specifier: string; installed: boolean; loaded: boolean; files: { path: string; bytes: number }[]; source: string },
          { action: 'inspect'; toolName?: string; skill?: string }
        >;
  }
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/_+/g, '_');
}

// The exact, whitelisted API surface a compiled plugin may use against its environment. Given to the
// codegen pass verbatim so it builds against real signatures rather than guessing — and so it knows it
// has nothing else: HTTP is `fetch`, an LLM call is `services.singleTurn`, another tool is the typed
// `tool` proxy, everything else is plain JS.
const MACHINE_API = `// --- Environment API available to the generated plugin (and nothing beyond it) ---
type ToolEvent =
  | { type: 'progress'; pct: number; message?: string }   // pct is a percentage 0-100, never a 0-1 fraction
  | { type: 'result';   value: unknown }
  | { type: 'error';    message: string };

interface ToolContext {
  callId:    string;
  session:   Session;
  signal:    AbortSignal;        // pass to fetch / singleTurn so the call is cancellable
  provider?: string;             // the turn's LLM provider key; default singleTurn to this
  prompt?:   PromptFn;           // interactive prompt channel from the calling turn
}

// LLM call — for any "reason about" / "summarise" / "decide" step there is EXACTLY ONE primitive,
// the single_turn TOOL. Its provider is optional and defaults to this turn's model:
//   const s = await tool.single_turn({ prompt, system });   // s.text
// A spec that says "no provider" means: omit the provider field. To force a specific provider, pass
// it (provider: '...') or use toolInContext({ provider }).single_turn(...). NEVER fabricate a
// provider name ('' or 'default'), and do not reach for services.* LLM plumbing — tool.single_turn
// is the whole surface.

// tool and toolInContext come from the "const { tool, toolInContext } = makeToolBox(services, ctx)" line
// already in the template below — keep that line. Call another registered tool through tool; it returns
// that tool's STRUCTURED result, already typed by the tool name, awaited:
const r = await tool.<tool_name>(params);
// tool uses THIS call's context (session, signal, prompt, provider), so a callee that needs an LLM
// (find_fact, or anything using singleTurn) or the user (ask_user) works with no extra wiring. To run one
// call under a different context, use the toolInContext factory — omitted fields are inherited:
//   await toolInContext({ provider: '...' }).<tool_name>(params);
// A tool name that does NOT exist is a COMPILE error (tool has no such property) — you cannot call a tool
// that isn't registered, so never guess a name. NEVER JSON.parse or regex a value out of a tool's prose.
// A multi-action tool's proxy is an OVERLOAD SET: its result type narrows by the params you pass, but
// ONLY at a direct call — so PREFER assigning the call directly (no narrowing obligation follows):
//   const r = await tool.<name>({ action: '...' });
// Pre-declaring instead (e.g. to assign inside try/catch) costs you: ToolResultOf<'<name>'> is the
// union across ALL the tool's arms, so every property access on it first needs an ARM guard —
// 'field' in r — a null/undefined check does NOT narrow which arm you have:
//   let r: ToolResultOf<'skill_action'>;  r = await tool.skill_action({ action: 'metadata', name });
//   if ('knowledge' in r) { /* r.knowledge usable here */ }
// Never type a variable as ReturnType<typeof tool.<name>>: an overload set does not narrow through
// ReturnType (you get the loose union at best, an arbitrary arm at worst).
// Common results (already typed):
//   const facts = await tool.find_fact({ question, terms: [{ term, context }] });  // string[] | null
//   const a     = await tool.ask_user({ name, label, type: 'text' });              // a.answer
//   const d     = await tool.contextual_search({ terms: [{ term }] });             // d.content (a document)
// ask_user THROWS when the user cancels the prompt — if the spec treats a cancel as "skip" or "use the
// default", wrap the call in try/catch; do not let the throw abort a loop the spec says continues.
// Single specific datum (a city, id, threshold) → find_fact, NOT contextual_search. When a tool has
// several result shapes, narrow with a runtime guard ('field' in r, or Array.isArray) before use.

// HTTP is the Web fetch() — no node http, no axios. JSON parsing/maths/dates/etc. are plain JS.`;

// The strict-TS reminder shared by the repair and iterate prompts (the initial codegen prompt spells it
// out in full). Kept in one place so those two prompts don't drift.
const STRICT_TS = 'Remember verbatimModuleSyntax (use `import type` for type-only imports, `import` for value imports), exactOptionalPropertyTypes (omit an optional key rather than passing undefined), and noUncheckedIndexedAccess (guard every array[i] before use).';

// There used to be a hardcoded three-arm `ToolContracts` fallback here (ask_user, find_fact,
// contextual_search), used when the live dts could not be derived. It is deliberately gone. A stub is not a
// smaller truth, it is a false one: the codegen prompt asserts "a tool not declared here does not exist",
// so under a stub that sentence is wrong about most of the registry, and the model closes the gap by
// declaring contracts itself — asserting shapes tsc cannot contradict. The dts is an INPUT to generation,
// derived from the live registry and nothing else; when it cannot be derived the compile fails.

// Where compiled plugins are written, installed from, and loaded — relative to the project root (the
// dir holding matbot.yaml). NOT `.data/` (the LLM's read-write workspace) nor `.plugins/` (the
// re-fetchable remote cache: a compiled plugin has no upstream, so a cache clear would lose it
// forever). A dedicated, gitignored, durable home of its own. Change here if that decision changes.
const COMPILED_PLUGINS_DIR = 'compiled-plugins';

// Render a committed session as an ordered, readable trace: the agent's reasoning, narration, tool
// calls and their results, interleaved as they happened. Tool results are paired to calls by id and
// truncated — a distillation pass reads this to separate the working method from exploratory steps.
function buildTranscript(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') continue;
    for (const c of m.content) {
      switch (c.type) {
        case 'thinking':    out.push(`[THINKING]\n${c.thinking}`); break;
        case 'text':        out.push(`[SAYS]\n${c.text}`); break;
        case 'tool-call':   out.push(`[CALLS #${c.id}] ${c.name}(${JSON.stringify(c.input)})`); break;
        case 'tool-result': {
          const r = typeof c.result === 'string' ? c.result : JSON.stringify(c.result) ?? '';
          out.push(`[RESULT #${c.id}${c.isError ? ' ERROR' : ''}] ${r.slice(0, 800)}${r.length > 800 ? ' …(truncated)' : ''}`);
          break;
        }
        default: break;
      }
    }
  }
  return out.join('\n\n');
}

export function createSkillCompilerPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async setup(services: MatbotMachine) {
      const executor: ToolExecutor<ToolResultOf<'skill_compiler'>> = {
        async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'skill_compiler'>>> {
          const inp = input as {
            action?: 'compile' | 'inspect';
            skill?: string; provider?: string; packageNamePrefix?: string; toolName?: string; feedback?: string;
          };
          const action = inp.action ?? 'compile';

          if (!services.configPath) {
            yield { type: 'error', message: 'No configPath available; cannot locate the project root on disk.' };
            return;
          }
          const { dirname, join } = await import('node:path');
          const projectRoot = dirname(services.configPath);

          // ── inspect: read back the current compiled version (source + file listing), no mutation ──
          if (action === 'inspect') {
            const target = sanitise((typeof inp.toolName === 'string' && inp.toolName.trim()) ? inp.toolName : (typeof inp.skill === 'string' ? inp.skill : ''));
            if (!target) {
              yield { type: 'error', message: 'inspect requires "toolName" (or "skill" to derive it).' };
              return;
            }
            const relDir    = `${COMPILED_PLUGINS_DIR}/${target}`;
            const buildDir  = join(projectRoot, COMPILED_PLUGINS_DIR, target);
            const specifier = `./${relDir}`;
            const { readFile, readdir, stat } = await import('node:fs/promises');

            let source: string;
            try {
              source = await readFile(join(buildDir, 'src', 'index.ts'), 'utf8');
            } catch {
              yield { type: 'result', value: { status: 'not_found_on_disk', toolName: target, dir: relDir, message: `No compiled plugin found at ${relDir}. Compile the skill first, or check the tool name.` } };
              return;
            }

            let version = '';
            let pluginName: string | undefined;
            try {
              const pj = JSON.parse(await readFile(join(buildDir, 'package.json'), 'utf8')) as { version?: string; name?: string };
              if (typeof pj.version === 'string') version = pj.version;
              if (typeof pj.name === 'string') pluginName = pj.name;
            } catch { /* package.json optional for inspection */ }

            // Recursive listing of the generated source, skipping the symlinked peer-dep node_modules.
            const walk = async (dir: string, prefix: string): Promise<{ path: string; bytes: number }[]> => {
              let entries;
              try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
              const out: { path: string; bytes: number }[] = [];
              for (const e of entries) {
                if (e.name === 'node_modules') continue;
                const rel  = prefix ? `${prefix}/${e.name}` : e.name;
                const full = join(dir, e.name);
                if (e.isDirectory()) out.push(...await walk(full, rel));
                else if (e.isFile()) { const st = await stat(full); out.push({ path: rel, bytes: st.size }); }
              }
              return out;
            };
            const files = await walk(buildDir, '');

            let installed = false;
            let loaded = false;
            try {
              const list = await toolResult(invokeTool(services, 'plugin', { action: 'list' }, ctx)) as { loaded?: { name?: string }[]; configured?: string[] };
              installed = (list.configured ?? []).includes(specifier);
              loaded = (list.loaded ?? []).some(p => p.name === pluginName);
            } catch { /* `plugin` tool absent → install state unknown (reported false) */ }

            yield {
              type: 'result',
              value: {
                status: 'inspected', toolName: target, ...(pluginName !== undefined ? { pluginName } : {}),
                version, dir: relDir, specifier, installed, loaded, files, source,
              },
            };
            return;
          }

          // ── compile ────────────────────────────────────────────────────────────
          const skill = inp.skill;
          if (!skill || typeof skill !== 'string') {
            yield { type: 'error', message: 'Parameter "skill" is required.' };
            return;
          }
          const feedback = (typeof inp.feedback === 'string' && inp.feedback.trim()) ? inp.feedback.trim() : undefined;

          const codeProvider = inp.provider || ctx.provider;
          if (!codeProvider) {
            yield { type: 'error', message: 'No provider available.' };
            return;
          }

          // Deterministic destination — derived from the inputs alone (not from distillation), so a
          // recompile of the same skill targets the same package and we can detect a prior version up
          // front. Both toolName and the package suffix default to the skill's safe name; both overridable.
          const toolName = sanitise((typeof inp.toolName === 'string' && inp.toolName.trim()) ? inp.toolName : skill);
          const packagePrefix = (typeof inp.packageNamePrefix === 'string' && inp.packageNamePrefix.trim()) ? inp.packageNamePrefix.trim() : '@local/compiled-';
          const pluginPkgName = `${packagePrefix}${toolName}`;
          const pluginDir = toolName;
          const relDir    = `${COMPILED_PLUGINS_DIR}/${pluginDir}`;
          const buildDir  = join(projectRoot, COMPILED_PLUGINS_DIR, pluginDir);
          const specifier = `./${relDir}`;

          const { readFile, writeFile } = await import('node:fs/promises');

          // Prior compiled source on disk + operator feedback ⇒ ITERATE: edit the existing implementation
          // instead of re-demonstrating from scratch. Re-demonstration discards working code and can
          // re-derive the very assumption that failed at runtime; the feedback names the fix and the
          // existing source is the base the codegen edits. Iterate does not require the source skill to
          // still exist (the compiled source is the base), so a hidden or deleted skill is fine here.
          let priorSource: string | undefined;
          try { priorSource = await readFile(join(buildDir, 'src', 'index.ts'), 'utf8'); } catch { /* first compile */ }
          const iterate = feedback !== undefined && priorSource !== undefined;

          yield { type: 'progress', pct: 5, message: iterate ? `Iterating on "${toolName}"...` : `Loading "${skill}"...` };
          const doc = await services.SkillManager?.get(skill);
          if (!iterate) {
            if (!doc) {
              yield { type: 'result', value: { status: 'not_found', message: `Skill "${skill}" not found.` } };
              return;
            }
            // The procedural/informational split is derived once by the skills metadata pass and cached on
            // the doc — we read it rather than re-classify. Absent only until that pass has run: re-saving
            // the skill regenerates it. Only a primarily-procedural skill describes a method to compile.
            const c = doc.knowledge?.classification;
            if (!c) {
              yield { type: 'result', value: { status: 'no_metadata', skill, message: `Skill "${skill}" has no derived classification yet. Re-save the skill to generate its metadata, then retry.` } };
              return;
            }
            if (c.procedural <= c.informational) {
              yield { type: 'result', value: { status: 'not_compilable', skill, classification: c } };
              return;
            }
          }
          const skillContent = doc?.content ?? '';
          const classification = doc?.knowledge?.classification ?? { procedural: 0, informational: 0 };

          // Derive the tool-result / service types from the LIVE loaded plugins BEFORE any codegen: the
          // same dts is embedded in every codegen prompt (so the model generates against the real
          // signatures instead of guessing and repairing towards them) and written to
          // src/matbot-tools.d.ts at scaffold time (so tsc checks the identical truth). The plugin list
          // also tells us whether this plugin is already installed/loaded — which decides add vs reload
          // at install time.
          yield { type: 'progress', pct: 6, message: 'Deriving tool contracts...' };
          let toolContractsDts: string | undefined;
          let alreadyInstalled = false;
          try {
            let pluginUrls: string[] = [];
            try {
              const list = await toolResult(invokeTool(services, 'plugin', { action: 'list' }, ctx)) as { loaded?: Array<{ resolvedUrl?: string; name?: string }>; configured?: string[] };
              pluginUrls = (list.loaded ?? [])
                .map(p => p.resolvedUrl)
                .filter((u): u is string => typeof u === 'string')
                // Drop a prior compiled version of THIS tool: its source carries a ToolContracts arm for
                // `${toolName}`, which would collide with the fresh src/index.ts's own arm in one typecheck.
                .filter(u => !u.includes(`${COMPILED_PLUGINS_DIR}/${pluginDir}/`));
              alreadyInstalled = (list.configured ?? []).includes(specifier) || (list.loaded ?? []).some(p => p.name === pluginPkgName);
            } catch { /* `plugin` tool absent → buildMatbotToolsDts falls back to the monorepo glob */ }
            // Live tool names, because the prompt below says "A tool not declared here does not exist" and
            // tsc grades the generated source against the same text: a contract scanned off an unloaded
            // plugin's source would make that sentence false in the one direction the model can't recover
            // from — it composes a call that compiles and then throws at runtime.
            const generated = await buildMatbotToolsDts(projectRoot, pluginUrls, services.tools.list().map(t => t.name));
            if (generated) {
              toolContractsDts = generated.dts;
              yield { type: 'progress', pct: 8, message: `Typed ${generated.tools.emitted.length} tool result(s) and ${generated.services.emitted.length} service(s).` };
            }
          } catch { /* reported below — an undefined dts is the one signal that matters here */ }

          // No dts, no compile. This used to fall back to three hardcoded arms, and that fallback was the
          // defect: the prompt tells the model "a tool not declared here does not exist", so a stub makes
          // that sentence false about most of the registry, and the model fills the gap by declaring
          // contracts itself — asserting shapes tsc cannot contradict (measured: an invented
          // `whoami: ToolContract<{ id: string; type: string }, {}>` that compiled clean and only resembled
          // the real `Principal`). The dts is an INPUT to code generation, derived from the live registry;
          // when it cannot be derived, the honest outcome is no generated tool, not a guessed one. An empty
          // derived set is fine and NOT this case — "we know of no tools" is true, and the gate holds the
          // model to it.
          if (toolContractsDts === undefined) {
            yield { type: 'error', message:
              'Could not derive the tool contracts this plugin would be generated against, so nothing was ' +
              'generated. The compiler types generated code off the live tool registry; without it the model ' +
              'would be inventing contracts, which compile and then fail at runtime. Check that ' +
              '@matatbread/matbot-plugin-api resolves from the project (or that its source is present), then ' +
              'retry.' };
            return;
          }

          // The environment spec embedded in every codegen prompt (initial, iterate and repair): the
          // machine API plus the ambient contracts the build typechecks against — the prompt and tsc
          // see one truth. Hallucinating a tool or a signature now contradicts text that is IN context,
          // not just a file the model is told exists.
          const envBlock = `${MACHINE_API}

// --- REGISTERED TOOL CONTRACTS (matbot-tools.d.ts — ambient in this build) ---
// The complete set of tools reachable through \`tool\`, with their exact params and result shapes.
// A tool not declared here does not exist. The generated code typechecks against THIS file verbatim.
${toolContractsDts}
// --- END REGISTERED TOOL CONTRACTS ---`;

          // Fresh derives the method by demonstrating + distilling; iterate carries the operator feedback
          // as the "method" and seeds the repair loop with the existing source. `distilled` records
          // whether the codegen actually received a distilled method: false means the raw demonstration
          // trace was passed through instead (distiller unavailable/unusable), which the prompt then
          // labels honestly. Iterate never distils, so it stays true (the feedback IS the method).
          let method: string;
          let distilled = true;
          let excluded: string[] = [];
          let indexSource = '';
          let pass1Prompt: string;
          // The authoritative statement of what the tool must do, built once per path and used TWICE: in
          // pass 1's prompt, and as the standing system prompt for every repair pass (see repairSystem).
          let specBlock: string;
          // Written into the scaffold's package.json, which is where the host backfills a plugin's
          // manifest description from — so `plugin list` describes this package whatever the generated
          // source happens to declare. Undefined on iterate: the scaffold keeps what is already there.
          let pkgDescription: string | undefined;

          if (!iterate) {
            yield { type: 'progress', pct: 10, message: `Executing "${skill}"...` };
            if (!services.run || !services.sessions) {
              yield { type: 'error', message: 'No session runner.' };
              return;
            }

            // Demonstrate in a SEPARATE session, never ctx.session.id: the runner serialises turns per
            // session, so submitting back to the caller's session queues behind the very turn running
            // this tool and deadlocks (pump bails while s.running). A distinct session has its own queue.
            // It reuses the host's runner/store, so config, settings and tools are all present; it's a
            // throwaway, so we delete it once the demonstration turn completes.
            const principal = currentPrincipal();
            const nowIso = new Date().toISOString();
            const scratchId = crypto.randomUUID();
            const scratch: Session = {
              id: scratchId,
              version: crypto.randomUUID(),
              status: 'active',
              messages: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            };
            await services.sessions.set(scratchId, scratch);

            let finalSession: Session | undefined;
            try {
              const view = await services.run.open({
                sessionId: scratchId,
                signal: ctx.signal,
                // Thread the calling turn's interactive prompt channel into the demonstration so its
                // ask_user steps reach the real user (an interactive compile demonstrates the real
                // interactive flow). Without a channel, the runner's fallback answers each prompt with
                // its declared default and rejects default-less ones — which stalls any skill whose
                // procedure needs an answer only the user knows.
                ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}),
                content: [{
                  type: 'text',
                  origin: 'robo',
                  text: `Follow the instructions in the skill "${skill}". Apply them now — they take precedence over brevity.\n\n${skillContent}`,
                }],
                provider: codeProvider,
                principal,
              });

              let pct = 10;
              for await (const ev of view.events) {
                if (!('traceId' in ev) || ev.traceId !== view.traceId) continue;
                if (ev.type === 'done' || ev.type === 'aborted') { finalSession = ev.session; break; }
                if (ev.type === 'error') break;
                if (ev.type === 'thinking' || ev.type === 'text-delta') {
                  yield { type: 'progress', pct, message: ev.delta }
                  if (pct < 50)
                    pct += 1;
                }
              }
              // `error` carries no session; recover the committed transcript from the store before deletion.
              finalSession ??= (await services.sessions.get(scratchId)) ?? undefined;
            } finally {
              await services.sessions.delete(scratchId);
            }

            if (!finalSession) {
              yield { type: 'error', message: 'Demonstration produced no session to analyse.' };
              return;
            }

            // The committed session holds clean, ordered blocks (thinking / text / tool-call / tool-result) —
            // the agent's full working-out, false starts and all. We hand the WHOLE trace to a distillation
            // pass rather than scraping tool pairs: the reasoning blocks carry the real method (parse logic,
            // URLs/queries discovered mid-run), and only a model reading the whole thing can tell the steps
            // that produced the result from the exploratory calls that didn't.
            const transcript = buildTranscript(finalSession.messages);
            const toolCalls = finalSession.messages.flatMap(m => m.content.filter(c => c.type === 'tool-call'));
            if (toolCalls.length === 0) {
              yield { type: 'error', message: 'Demonstration captured no tool operations.' };
              return;
            }

            yield { type: 'progress', pct: 50, message: `Distilling ${finalSession.messages.length} messages, ${toolCalls.length} tool calls...` };

            const distillResult = await services.singleTurn({
              provider: codeProvider,
              system: `You analyse a trace of an AI agent working out how to perform a task. The trace interleaves the agent's reasoning ([THINKING]), narration ([SAYS]), tool calls ([CALLS]) and results ([RESULT]). Agents explore: they run discovery calls (listing plugins/servers, searching for context), make false starts, and hit dead-ends before finding what actually produces the answer. Extract the MINIMAL CORRECT METHOD — only the steps on the path that worked — and inline what discovery taught (a concrete URL, query, threshold or field name learned mid-run) as constants rather than re-deriving it. Discard every exploratory or incorrect step. When the skill names a mechanism generically (e.g. "an LLM call", "with no explicit provider") and the agent satisfied it with a persona or companion tool that happened to be available (ask_inner_voice, a chat/send tool), the method must name the NEUTRAL mechanism — the single_turn tool with provider omitted — not the substitute: the trace's choice is an accident of that session's environment, and the compiled tool must not depend on it.`,
              prompt: `Skill being performed:\n${skillContent}\n\n--- AGENT TRACE ---\n${transcript}\n--- END TRACE ---\n\nReturn ONLY JSON:\n{"toolDescription":"one line","parameters":[{"name":"...","type":"string|number|boolean","description":"...","required":true|false}],"resultType":"A self-contained TypeScript type for the value the compiled tool yields in its { type: 'result', value } event — derive it from the actual [RESULT] values seen in the trace, and include EVERY field observed (the generated implementation is type-checked against this exact type, so an omitted or wrong field fails the build). Primitives and inline object/array types only, no named types (e.g. 'string' or '{ total: number; items: string[] }'). When a field's values come from a fixed enumerable set the skill defines (a status, a category, a disposition), type it as a union of string literals ('a' | 'b' | 'c'), never bare string — the literal union is what downstream callers typecheck against. 'unknown' if indeterminate.","method":"Numbered, ordered steps the compiled tool must perform, with the exact mechanism for each: an HTTP step gives method + URL + body with discovered constants inlined; a tool step gives the tool name and exact args; a compute step gives the JS data-processing logic lifted from the reasoning. Exclude every exploratory/discovery/dead-end step.","excluded":["one short note per discarded exploratory step and why"]}`,
              signal: ctx.signal,
            });

            let design: any = { toolDescription: `Compiled from "${skill}"`, parameters: [], resultType: 'unknown', method: transcript, excluded: [] };
            try { const m = distillResult.text.match(/\{[\s\S]*\}/); if (m) design = { ...design, ...JSON.parse(m[0]) }; } catch {}
            // "Numbered, ordered steps" invites an array — models return one often enough that a
            // string-only check silently threw the distillation away and fell back to the raw
            // transcript (observed: excluded parsed, method = 17KB trace). Accept both shapes.
            const rawMethod: unknown = Array.isArray(design.method) ? design.method.map((s: unknown) => typeof s === 'string' ? s : JSON.stringify(s)).join('\n') : design.method;
            method = typeof rawMethod === 'string' && rawMethod.trim() ? rawMethod : transcript;
            distilled = method !== transcript;
            excluded = Array.isArray(design.excluded) ? design.excluded : [];

            yield { type: 'progress', pct: 55, message: 'Preparing build...' };

            const toolDesc = (design.toolDescription as string).replace(/`/g, '\\`');
            pkgDescription = design.toolDescription as string;
            const toolParams = (design.parameters || []) as Array<{name: string; type: string; description: string; required: boolean}>;
            const reqd = toolParams.filter(p => p.required).map(p => JSON.stringify(p.name)).join(', ');
            const props = JSON.stringify(Object.fromEntries(toolParams.map(p => [p.name, { type: p.type, description: p.description }]))) || '{}';

            // The compiled tool's single-source contract, emitted into its src/index.ts as a ToolContracts
            // arm `ToolContract<Result, Params>`. The params half mirrors `inputSchema` exactly (same
            // source, so accurate by construction); the result half is the distiller's reading of the
            // observed result value. The generated executor binds off it via `ToolResultOf`, so the
            // typecheck verifies the impl actually yields the declared shape.
            const paramsTypeText = toolParams.length === 0
              ? '{}'
              : `{ ${toolParams.map(p => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join('; ')} }`;
            const resultTypeText = typeof design.resultType === 'string' && design.resultType.trim() ? design.resultType.trim() : 'unknown';

            specBlock = `THE SPECIFICATION — this is what the tool must achieve. It is authoritative:
--- SKILL "${skill}" ---
${skillContent}
--- END SKILL ---

${distilled ? `A WORKED EXAMPLE — one real run of an agent performing the skill, distilled to the path that worked (exploration and dead-ends already removed). Treat it as pseudo-code that disambiguates the spec: it pins down the concrete URLs, queries, field names, thresholds and ordering the prose leaves open. It is ONE execution, not the only one — implement the spec's general method, using this to resolve ambiguity and fill gaps, not as inputs to hard-code:
--- DISTILLED METHOD ---` : `A WORKED EXAMPLE — the RAW trace of one real run of an agent performing the skill (distillation was unavailable, so exploratory calls, false starts and dead-ends are still present). Use only the steps that produced correct results to disambiguate the spec; ignore discovery calls (e.g. tool_search) and failed attempts. It is ONE execution, not the only one — implement the spec's general method, never hard-code this run's inputs:
--- RAW DEMONSTRATION TRACE ---`}
${method}
${distilled ? '--- END METHOD ---' : '--- END TRACE ---'}
${feedback ? `
--- OPERATOR FEEDBACK (authoritative — apply this in addition to the spec) ---
${feedback}
--- END FEEDBACK ---
` : ''}`;

            pass1Prompt = `Generate TypeScript for a matbot plugin that implements the following skill as a deterministic tool.

${specBlock}
${envBlock}

Template (fill IMPLEMENTATION):
\`\`\`ts
import { PLUGIN_API_VERSION, makeToolBox } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';

// This tool's call contract — a single ToolContracts arm pairing its result with its params. It is the
// ONE source: the executor binds its result off it (ToolResultOf), and a composer typing
// \`await tool.${toolName}(params)\` reads it. Keep this block exactly as generated.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    ${toolName}: ToolContract<${resultTypeText}, ${paramsTypeText}>;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: \`${toolDesc}\` },   // what \`plugin list\` shows for the package; keep it
  async setup(services: MatbotMachine) {
    const executor: ToolExecutor<ToolResultOf<'${toolName}'>> = {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'${toolName}'>>> {
        const { tool, toolInContext } = makeToolBox(services, ctx);   // await tool.<name>(params); override: toolInContext({ provider }).<name>(params)
        try {
          // IMPLEMENTATION
          yield { type: 'result', value: { done: true } };
        } catch (e) {
          yield { type: 'error', message: \`Error: \${e instanceof Error ? e.message : String(e)}\` };
        }
      },
    };
    services.tools.register({
      name: '${toolName}',
      description: \`${toolDesc}\`,
      inputSchema: { type: 'object', required: [${reqd}], properties: ${props} },
      executor,
    });
  },
};
\`\`\`

Rules: implement the SPEC, using the worked example's exact URLs/queries/field names to remove ambiguity. Reproduce only the steps that meet the spec — never the example's exploratory or discovery calls. Implement EVERY branch the spec describes — each arm of an if/else, each conditional path — even when the worked example exercised only one. The example is a single trace through the spec; the spec defines all the paths. E.g. if Step 1 says "if no result, ask for free text; if more than one result, present a choice", implement both the text ask_user and the select ask_user, not just whichever the example happened to hit. Drive everything off the tool's input parameters; treat the example's specific values as illustrative, not constants (except genuine endpoints/queries the spec implies are fixed). Pass ctx.signal through every fetch (\`tool.*\` calls inherit it automatically). Call other tools via \`await tool.<name>(params)\` — it inherits this call's session, signal, prompt AND provider automatically, so a callee that needs an LLM (find_fact, single_turn) or the user (ask_user) just works with no wiring; to run a sub-call under a different context use \`await toolInContext({ provider }).<name>(params)\` (omitted fields inherited). A tool name that isn't registered will NOT compile, so never invent one. Yield progress/result/error events. NEVER extract a value from another tool's natural-language output with a regex or fixed-phrase string match (e.g. searchResult.match(/the location is (.+)/)) — that assumes an exact wording the tool will not reliably produce, so it silently fails. When a step needs a specific stored fact, use the find_fact tool (structured JSON { found, fact }), NOT contextual_search followed by string-parsing of its prose; if the spec names contextual_search for what is really a single-fact lookup, translate it to find_fact. A \`tool.<name>(...)\` value is already precisely typed by the tool's contract (see REGISTERED TOOL CONTRACTS above) — use it directly, or, when the tool has several result shapes, narrow with a runtime guard ('field' in r, or Array.isArray). Do NOT cast it away and then re-assert a shape onto it — neither 'as unknown as X', nor 'as Record<string, unknown>' followed by '[key] as X'. Re-asserting a shape that TypeScript can no longer check is an unvalidated assumption: if the guess is wrong it still compiles and the tool is silently broken. The ONLY genuinely-unknown values are EXTERNAL inputs (e.g. await resp.json()); validate those with runtime checks before use rather than asserting a type onto them. These cast rules are ENFORCED by the build, not advisory: 'as any', 'as unknown as T', and widening an already-typed value to Record<...>/object/unknown are all rejected exactly like type errors. The project enforces strict TypeScript: verbatimModuleSyntax — use \`import type\` for type-only imports and \`import\` for value imports; never use bare default imports unless the module has a real default export. The project also enables exactOptionalPropertyTypes — when a property is optional (key?: T), never pass undefined explicitly; omit the key instead. It enables noUncheckedIndexedAccess — array indexing returns T | undefined, so guard every array[i] access before using it. The executor is typed to the tool's result type (\`ToolExecutor<ToolResultOf<'${toolName}'>>\`), so the value you yield in the result event must be assignable to it — the typecheck enforces this. Keep the \`declare module … interface ToolContracts { ${toolName}: ToolContract<…> }\` block and the register call's \`name\` and \`inputSchema\` exactly as in the template — that augmentation IS the tool's declared contract, the single source other tools compose against. Output ONLY src/index.ts in a typescript fence.`;
          } else {
            // Iterate: the existing source is the base; feedback names the change. Seed the repair loop with
            // the current source so a first-pass typecheck failure still repairs against it.
            indexSource = priorSource!;
            method = feedback!;
            // Iterate's spec is the operator's change, read against the original skill as context — NOT the
            // prior source, which the repair pass is already looking at (and which is exactly what the
            // change is meant to alter).
            specBlock = `THE SPECIFICATION — the tool must do what it did before, WITH the operator's change below applied. The change is authoritative:
--- OPERATOR FEEDBACK (the change to make) ---
${feedback}
--- END FEEDBACK ---
${skillContent ? `
--- ORIGINAL SKILL SPEC "${skill}" (context — the source implements this; the change above amends it) ---
${skillContent}
--- END SKILL ---
` : ''}`;

            pass1Prompt = `You are modifying an existing, installed matbot plugin — apply the operator's requested change to its source and return the complete corrected src/index.ts.

${envBlock}
${skillContent ? `
--- ORIGINAL SKILL SPEC "${skill}" (context — the source below is the current implementation of it) ---
${skillContent}
--- END SKILL ---
` : ''}
--- CURRENT src/index.ts ---
${priorSource}
--- END CURRENT ---

--- OPERATOR FEEDBACK (the change to make) ---
${feedback}
--- END FEEDBACK ---

Apply exactly the operator's change and nothing more. Keep everything else identical — the tool name, its \`declare module … interface ToolContracts { ${toolName}: ToolContract<…> }\` block, and the register call's \`name\` and \`inputSchema\` — unless the feedback explicitly requires changing it. Pass ctx.signal through every fetch (\`tool.*\` calls inherit it automatically); call other tools via \`await tool.<name>(params)\` (it inherits this call's context, and an unregistered tool name will not compile; use \`toolInContext({ provider })\` to override). Never extract a value from another tool's natural-language output with a regex — use its typed tool.<name>() result, or find_fact for a single stored fact. Do NOT cast a toolResult value with 'as unknown as X' or re-assert a shape onto it; validate only genuinely external values (e.g. await resp.json()). ${STRICT_TS} Output ONLY the complete corrected src/index.ts in a single \`\`\`typescript fence — the whole file, not a diff.`;
          }

          // The repair passes' standing system prompt. Pass 1 states the spec; every pass after it used to
          // see only the broken source and the diagnostics, which left the source as the spec's only
          // stand-in — three rounds of "fix this" with nothing authoritative to fix TOWARDS, inviting a
          // compiler-satisfying deletion of the very behaviour that raised the error, and (over 4 passes)
          // letting each attempt drift from the last with nothing pulling it back. Carried as `system`
          // rather than re-stated in each prompt for two reasons: it is byte-identical across passes 2..N,
          // so the anthropic adapter's system-block cache breakpoint means it is paid for once, not per
          // attempt (the context stops growing with the attempt count); and instructions the model must not
          // trade away sit above the pasted source and error text rather than competing with it.
          // NOTE it deliberately differs from pass 1's framing: generation needs "build this", repair needs
          // "you are 3 edits deep into someone else's attempt at this" — the failure modes are not the same,
          // so the discipline below is repair-specific and would be noise during generation. That costs one
          // cache miss at pass 2 (toAnthropicSystem flattens system to a single block with one trailing
          // breakpoint, so any change to the tail misses the whole block); passes 3..N hit.
          const repairSystem = `You are repairing the TypeScript of a matbot plugin that implements a specification. The specification is below and remains in force for every repair you make.

${specBlock}
${envBlock}

Your job is to make the code COMPILE while it still implements that specification. The source you are given is a PREVIOUS ATTEMPT at the specification, not a second source of truth: where the two disagree, the specification wins. Fix every reported error with the smallest change that fixes it — do not refactor, rename or restructure anything the errors do not name.

NEVER resolve an error by removing something the specification requires. Concretely: do not drop a field from the result value, do not yield a placeholder or stub where a computed value belongs, do not delete a branch, a tool call or an error path, and do not weaken the \`ToolContracts\` arm or the \`inputSchema\` so that they match what the code currently happens to produce. A mismatch between the declared contract and the implementation means the IMPLEMENTATION is wrong — the contract is derived from the specification, so change the code to produce the declared shape. Deleting the offending code silences the compiler and ships a tool that does not do what it claims, which is worse than the error you were asked to fix.

This may be the third or fourth attempt at this file, so it may already have drifted: if an earlier pass has dropped or stubbed something the specification requires, restore it as part of your fix — that is not scope creep. Keep the tool name, the \`declare module … interface ToolContracts { ${toolName}: ToolContract<…> }\` block and the register call's \`name\` and \`inputSchema\` exactly as they are. ${STRICT_TS}`;

          // ── shared build ─────────────────────────────────────────────────────────
          // Write the plugin straight to disk with node:fs — NOT via workspace_action. The workspace is
          // the user's artifact space, and routing build files through it created a hidden dependency on
          // the workspace plugin plus a false assumption that the file store materialises on the local
          // filesystem. The build needs a real local path it owns.

          // The scaffold — package.json, a self-contained tsconfig, the ambient tool dts, and the
          // plugin-api link that is the only way tsc and Node resolve it here. Its own module because
          // what it must NOT assume (that matbot.yaml sits at a source checkout's root) is worth
          // stating once, in one place, with the measurements behind it.
          yield { type: 'progress', pct: 68, message: 'Writing plugin scaffold...' };
          let version: string;
          try {
            ({ version } = await writePluginScaffold({
              buildDir, configDir: projectRoot, pkgName: pluginPkgName, toolContractsDts,
              ...(pkgDescription !== undefined ? { description: pkgDescription } : {}),
            }));
          } catch (e) {
            yield { type: 'error', message: `Could not write plugin to ${relDir}: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          // Generate → typecheck → on failure feed the errors + current code back for repair, up to
          // MAX_PASSES. The repair loop OWNS the broken file so the calling LLM never has to find or patch
          // it by hand; only after the loop gives up do we surface the errors as a result. The typecheck
          // is the compiler API in a worker thread (see ts-check.ts) — off the main loop so the web UI
          // stays live, and with NO fallback: the inputs are fully determined (our own scaffold, our own
          // tsconfig, the resolved typescript module), so a checker failure is a bug in our plumbing and
          // must surface as this compile's error, not be absorbed by a quieter path.
          // 4 rather than 3: the cast gate's structural findings legitimately consume repair budget
          // alongside type errors, and the small-model tier was exhausting 3 passes on exactly that
          // combination.
          const MAX_PASSES = 4;
          const extractSource = (text: string): string => {
            const m = text.match(/```(?:typescript|ts)\s*\n([\s\S]*?)```/) || text.match(/```\s*\n([\s\S]*?)```/);
            let src = m ? m[1]!.trim() : text.trim();
            if (!src.startsWith('import')) {
              const i = src.indexOf('\nimport ');
              if (i >= 0) src = src.slice(i + 1);
            }
            return src;
          };

          let typecheckOk = false;
          let typecheckOutput = '';
          let pass = 0;
          for (pass = 1; pass <= MAX_PASSES && !typecheckOk; pass++) {
            yield { type: 'progress', pct: 70 + pass * 6, message: pass === 1 ? (iterate ? 'Applying feedback...' : 'Generating code...') : `Typecheck failed — repairing (pass ${pass}/${MAX_PASSES})...` };

            // WHAT REMAINS OPEN, now that repairSystem carries the spec: the loop can no longer resolve an
            // error by deleting behaviour it has no reason to keep, but nothing here grades whether the code
            // that finally compiles actually MEETS the spec. A pass-1 mis-implementation that typechecks — a
            // branch the spec describes but the demonstration never exercised, an example value frozen as a
            // constant — still installs clean, and no repair pass ever runs to notice it.
            // Deliberately NOT solved with a final "does this meet the spec?" LLM pass, for two reasons that
            // are about the shape of the answer rather than its cost. Asked generally it returns a hedge
            // ("this will fail if the endpoint ever returns …") — unfalsifiable, and true of all code. And a
            // negative verdict has nowhere to go: reporting it defers to the operator to tighten the spec
            // (fine, but that is advice, not a gate), while feeding it back into codegen re-enters this loop
            // and makes MAX_PASSES meaningless, since a conformance objection can always be raised again.
            // If it is ever built it wants a STRUCTURAL question with a checkable answer — "list every branch
            // the spec describes and the line implementing it, or MISSING" — not a verdict; the same move the
            // cast gate made when it replaced prompt prose with a deterministic finding.
            // The repair prompt carries ONLY what changes between passes — the current source and the latest
            // diagnostics. Everything standing (spec, environment, repair discipline, strict-TS) is in
            // repairSystem, so the prompt does not accumulate and the errors are the last thing read.
            const prompt = pass === 1 ? pass1Prompt :
`The TypeScript below does not compile. Return a corrected version.

--- CURRENT src/index.ts (attempt ${pass - 1} of ${MAX_PASSES}) ---
${indexSource}
--- END CURRENT ---

--- TYPECHECK ERRORS (the offending source is anchored under each; a HINT line names the idiomatic fix) ---
${typecheckOutput}
--- END ERRORS ---

Fix every reported error, keeping the specification satisfied. Output ONLY the complete corrected src/index.ts in a single \`\`\`typescript fence — the whole file, not a diff.`;

            const codeResult = await services.singleTurn({
              provider: codeProvider,
              prompt,
              ...(pass === 1 ? {} : { system: repairSystem }),
              signal: ctx.signal,
            });
            const src = extractSource(codeResult.text);
            if (!src.includes('MatbotPluginSpec')) {
              typecheckOutput = 'Your reply did not contain a valid plugin (no MatbotPluginSpec found). Output ONLY the complete src/index.ts in a single ```typescript``` fence.';
              continue;
            }
            indexSource = src;

            try {
              await writeFile(join(buildDir, 'src', 'index.ts'), indexSource);
            } catch (e) {
              yield { type: 'error', message: `Could not write ${relDir}/src/index.ts: ${e instanceof Error ? e.message : String(e)}` };
              return;
            }

            // `ownContracts`: this tool's arm is the one the template tells it to keep; an arm for any OTHER
            // tool is an assertion about a contract it was handed, and is rejected like a cast.
            const tc = await checkProjectDir(buildDir, { ownContracts: [toolName] });
            if (tc.ok) typecheckOk = true;
            else typecheckOutput = tc.output.trim() || 'typecheck failed';
          }

          if (!typecheckOk) {
            yield { type: 'progress', pct: 100, message: `Done — typecheck failed after ${MAX_PASSES} passes.` };
            yield {
              type: 'result',
              value: {
                status: 'typecheck_failed', skill, toolName, version, dir: relDir, passes: MAX_PASSES, iterated: iterate,
                distilled, method, excluded, typecheckOutput: typecheckOutput.slice(0, 4000),
              },
            };
            return;
          }

          // Install (first compile) or reload (a prior version is live) so the NEW code actually takes
          // effect: `plugin add` on an already-configured specifier is a no-op that leaves the old code
          // resident, so an installed plugin must go through `reload` (unload + re-import from disk).
          // Both go via the `plugin` tool — a soft dependency: if it isn't loaded, the plugin is fully
          // built on disk, so report compiled_not_installed with the specifier rather than failing.
          if (!services.tools.resolve('plugin')) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName, version,
                dir: relDir, specifier, typecheckOk, iterated: iterate, distilled, method, excluded,
                installError: 'The `plugin` management tool is not loaded; install it manually with: plugin add ' + specifier,
              },
            };
            return;
          }
          yield { type: 'progress', pct: 94, message: alreadyInstalled ? 'Reloading plugin...' : 'Installing plugin...' };
          let installMessage: string;
          try {
            installMessage = await toolText(invokeTool(services, 'plugin',
              alreadyInstalled ? { action: 'reload', specifier } : { action: 'add', specifier },
              ctx));
          } catch (e) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName, version,
                dir: relDir, specifier, typecheckOk, iterated: iterate, distilled, method, excluded,
                installError: e instanceof Error ? e.message : String(e),
              },
            };
            return;
          }

          // A declined/cancelled install confirmation is a RESULT from the `plugin` tool ("Cancelled."),
          // not a throw — so don't trust the message text, verify the effect: the plugin took hold only if
          // the compiled tool is now resolvable. Checked on BOTH paths. It used to skip the check whenever
          // the plugin was already configured, which assumed the reload path always has an old version still
          // loaded — and when it does not (a build dir deleted under a config that still lists it, so the
          // boot load failed), a cancelled reload reported `installed` and went on to hide the source skill:
          // no tool, and the skill that described it hidden too. What remains genuinely undetectable is a
          // cancelled reload masked by a still-resolvable OLD version; the registry cannot tell those apart.
          if (!services.tools.resolve(toolName)) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName, version,
                dir: relDir, specifier, typecheckOk, iterated: iterate, distilled, method, excluded,
                installError: `Install did not take effect: ${installMessage}`,
              },
            };
            return;
          }

          // Rewire any triggers that fired the *skill* (`skill_action(use, <skill>)`) onto the new tool, so
          // the deterministic tool answers the condition instead of the skill prose being injected. Soft
          // dependency on `trigger_action` (orthogonal subsystem): if it isn't loaded, skip silently. On an
          // iterate this is a no-op (already moved on the first compile).
          let movedTriggers: { id: string }[] = [];
          if (services.tools.resolve('trigger_action')) {
            try {
              const moved = await toolResult(invokeTool(services, 'trigger_action',
                { action: 'move', tool: 'skill_action', params: { action: 'use', name: skill }, toTool: toolName },
                ctx)) as { triggers?: { id: string }[] };
              movedTriggers = moved.triggers ?? [];
            } catch { /* fails soft — install already succeeded */ }
          }

          // Retire the source skill from the model now its method lives in a deterministic tool: hide it so
          // its prose is no longer search-surfaced or catalogued. It stays for management and as the
          // compiler's source. Only hide a skill that still exists (iterate may run without one). Soft:
          // if SkillManager is absent or it throws, install stands.
          let hidden = false;
          try {
            if (services.SkillManager && doc) {
              await services.SkillManager.setHidden(skill, true);
              hidden = true;
            }
          } catch { /* fails soft — install already succeeded */ }

          yield { type: 'progress', pct: 100, message: `Done — compiled, typechecked, ${alreadyInstalled ? 'reloaded' : 'installed'}.` };
          yield {
            type: 'result',
            value: {
              status: 'installed', skill, classification, passes: pass - 1, iterated: iterate, distilled,
              toolName, pluginName: pluginPkgName, version, dir: relDir, specifier, typecheckOk,
              method, excluded, install: installMessage,
              movedTriggers: movedTriggers.map(t => t.id), hidden,
            },
          };
        },
      };

      services.tools.register({
        name: 'skill_compiler',
        description: `Compile a procedural markdown skill into an executable TypeScript plugin, then install it — or iterate on / inspect an already-compiled one.

action:
  compile (default): load from SkillManager → classify (only procedural skills compile) → demonstrate in a scratch session capturing the real working trace → distil the trace to the method that worked → generate TypeScript → typecheck (annotated compiler diagnostics + structural cast gate), feeding findings back to self-repair (up to 4 passes) → install (asks for confirmation) → move any skill-firing triggers onto the new tool, then hide the source skill. If a compiled version already exists AND you pass "feedback", it ITERATES instead: it edits the existing source to apply your feedback (skipping re-demonstration, so working code is preserved) and reloads the running plugin in place.
  inspect: read back the current compiled version — its source, file listing, version and install state — without changing anything.

Fixing a compiled tool that fails at RUNTIME (it typechecked but behaves wrong): inspect it to read the generated source, then compile again with "feedback" describing the fix (e.g. "the request URL uses the v1 ClickHouse path; this server needs /?query=").

Compiled plugins use: fetch() for HTTP, services.singleTurn() for LLM, the typed tool proxy for tools, plain JS for logic.`,
        inputSchema: {
          type: 'object',
          required: [],
          properties: {
            action: { type: 'string', enum: ['compile', 'inspect'], description: 'compile (default): build or iterate on the skill\'s compiled tool. inspect: read back the current compiled version without changing anything.' },
            skill: { type: 'string', description: 'Skill name from SkillManager. Required for compile; for inspect it derives the tool name when toolName is omitted.' },
            feedback: { type: 'string', description: 'Optional free-text fix or feature to apply. When a compiled version already exists, the compiler iterates on that source applying this feedback (instead of recompiling from scratch), then reloads it live. Describe the runtime problem or desired change; use action:inspect first to read the current source if you need to be specific.' },
            provider: { type: 'string', description: 'Optional code-gen provider. Defaults to turn provider.' },
            toolName: { type: 'string', description: 'Name of the compiled tool, and the suffix of its package name (compile); or the tool to read (inspect). Defaults to the skill\'s safe name (e.g. "Send To Telegram" → send_to_telegram). Non-identifier characters collapse to underscores.' },
            packageNamePrefix: { type: 'string', description: 'Prefix for the generated npm package name, prepended to the tool name. Defaults to "@local/compiled-".' },
          },
        },
        executor,
      });
    },
  };
}

export const plugin: MatbotPluginSpec = createSkillCompilerPlugin();
