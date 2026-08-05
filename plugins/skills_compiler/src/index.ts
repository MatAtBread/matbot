import { PLUGIN_API_VERSION, currentPrincipal, invokeTool, toolResult, toolText } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext, ToolContract, ToolResultOf, Session, Message } from '@matatbread/matbot-plugin-api';
import { buildMatbotToolsDts, checkProjectDir } from '@matatbread/matbot-tool-types';

// Loose discovery of the skills plugin's SkillManager — optional, so no hard dependency on the
// package. Only the slice this tool consumes is declared.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SkillManager?: {
      get(name: string): Promise<{
        content: string;
        knowledge?: { classification: { procedural: number; informational: number } };
      } | undefined>;
      setHidden(name: string, hidden: boolean): Promise<unknown>;
    };
  }
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

// Augments the generated plugin's view of `ToolContracts` so `toolResult(invokeTool(..., name, ...))` is
// typed for the common tools it calls. The real augmentations live in those tools' own packages
// (ask-user, rumsfeld), but the generated plugin is a separate compilation that only sees plugin-api —
// so we ship this alongside it. This is only the FALLBACK, used when no plugin source is scannable;
// normally buildMatbotToolsDts derives these arms from the live source. Kept in step (arm form) with
// those packages' ToolContracts declarations.
const TOOL_CONTRACTS_DTS = `import '@matatbread/matbot-plugin-api';
import type { ToolContract } from '@matatbread/matbot-plugin-api';
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    ask_user: ToolContract<{ name: string; answer: string }, { name: string; label: string; type: 'text' | 'password' | 'select' | 'confirm'; options?: string[]; allowOther?: boolean; default?: string; required?: boolean; cancelable?: boolean }>;
    find_fact: ToolContract<string[] | null, { question: string; terms: { term: string; context?: string }[]; provider?: string }>;
    contextual_search: ToolContract<{ name: string; content: string }, { terms: { term: string; context?: string }[] }>;
  }
}
`;

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
          const { dirname, join, relative } = await import('node:path');
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

          const { mkdir, readFile, symlink, readlink, writeFile } = await import('node:fs/promises');

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
          let toolContractsDts = TOOL_CONTRACTS_DTS;
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
            const generated = await buildMatbotToolsDts(projectRoot, pluginUrls);
            if (generated) {
              toolContractsDts = generated.dts;
              yield { type: 'progress', pct: 8, message: `Typed ${generated.tools.emitted.length} tool result(s) and ${generated.services.emitted.length} service(s).` };
            }
          } catch { /* keep the static fallback */ }

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

            pass1Prompt = `Generate TypeScript for a matbot plugin that implements the following skill as a deterministic tool.

THE SPECIFICATION — this is what the tool must achieve. It is authoritative:
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
` : ''}
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

          // ── shared build ─────────────────────────────────────────────────────────
          // Write the plugin straight to disk with node:fs — NOT via workspace_action. The workspace is
          // the user's artifact space, and routing build files through it created a hidden dependency on
          // the workspace plugin plus a false assumption that the file store materialises on the local
          // filesystem. The build needs a real local path it owns.

          // Compute relative paths from the plugin build dir to tsconfig.base.json and the plugin-api
          // package at the project root. The build dir is outside the pnpm workspace packages, so tsc
          // needs explicit paths to resolve the peer dep.
          const baseTsconfigPath = relative(buildDir, join(projectRoot, 'tsconfig.base.json'));
          const pluginApiPath = relative(buildDir, join(projectRoot, 'plugin-api', 'src', 'index.ts'));
          const tsconfigJson = JSON.stringify({
            extends: baseTsconfigPath,
            compilerOptions: {
              paths: { "@matatbread/matbot-plugin-api": [pluginApiPath] },
              declaration: false, declarationMap: false, sourceMap: false,
            },
            include: ["src/**/*"],
          }, null, 2);

          // Recompiling to the same destination is a new version, not a silent overwrite: read the version
          // already on disk (if any) and bump its patch. A first compile — or an unparseable/absent
          // package.json — starts at 0.1.0.
          let version = '0.1.0';
          try {
            const existing = JSON.parse(await readFile(join(buildDir, 'package.json'), 'utf8')) as { version?: string };
            const m = typeof existing.version === 'string' ? existing.version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
            if (m) version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
          } catch { /* no existing package.json → first version */ }
          const packageJson = JSON.stringify({
            name: pluginPkgName, matbotRuntime: ["node"], version, type: "module",
            exports: { ".": "./src/index.ts" }, files: ["src"],
            peerDependencies: { "@matatbread/matbot-plugin-api": "workspace:^" },
          }, null, 2);

          yield { type: 'progress', pct: 68, message: 'Writing plugin scaffold...' };
          try {
            await mkdir(join(buildDir, 'src'), { recursive: true });
            await writeFile(join(buildDir, 'package.json'), packageJson);
            await writeFile(join(buildDir, 'tsconfig.json'), tsconfigJson);
            await writeFile(join(buildDir, 'src', 'matbot-tools.d.ts'), toolContractsDts);
          } catch (e) {
            yield { type: 'error', message: `Could not write plugin to ${relDir}: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          // node_modules symlink so Node's ESM resolver finds the peer dep at runtime — the build dir is
          // outside the pnpm workspace packages, so it has no node_modules of its own.
          const linkDir = join(buildDir, 'node_modules', '@matatbread');
          const linkPath = join(linkDir, 'matbot-plugin-api');
          const linkTarget = join(projectRoot, 'plugin-api');
          try {
            await mkdir(linkDir, { recursive: true });
            try { await readlink(linkPath); } catch { await symlink(linkTarget, linkPath); }
          } catch (e) {
            yield { type: 'error', message: `Could not create node_modules symlink: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          // Generate → typecheck → on failure feed the errors + current code back for repair, up to
          // MAX_PASSES. The repair loop OWNS the broken file so the calling LLM never has to find or patch
          // it by hand; only after the loop gives up do we surface the errors as a result. The typecheck
          // is the compiler API in a worker thread (see ts-check.ts) — off the main loop so the web UI
          // stays live, and with NO fallback: the inputs are fully determined (our own scaffold, our own
          // tsconfig, the resolved typescript module), so a checker failure is a bug in our plumbing and
          // must surface as this compile's error, not be absorbed by a quieter path.
          // PARKED (potential safety enhancement): add a structural gate alongside this typecheck that
          // rejects re-assertion of a shape onto a `toolResult(...)`-derived value — `as unknown as X`, or
          // `as Record<string, unknown>` then `[k] as X` — and feeds it back into the repair loop like a tsc
          // error. `tsc` PASSES those casts (they are valid TS), so today only the codegen prompt rule
          // discourages them, and prompt-tuning has shown diminishing returns. Deterministic enforcement
          // beats prose if the guarantee is wanted. See memory `skills-compiler-cast-structural-guarantee`.
          // 4: the cast gate's structural findings legitimately consume repair budget alongside type
          // errors, and the small-model tier was exhausting 3 passes on exactly that combination.
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

            const prompt = pass === 1 ? pass1Prompt :
`The TypeScript you generated for this plugin does not compile. Return a corrected version.

${envBlock}

--- CURRENT src/index.ts ---
${indexSource}
--- END CURRENT ---

--- TYPECHECK ERRORS (the offending source is anchored under each; a HINT line names the idiomatic fix) ---
${typecheckOutput}
--- END ERRORS ---

Fix every reported error. Change only what each error requires; keep the tool name, inputs and behaviour identical. ${STRICT_TS} Output ONLY the complete corrected src/index.ts in a single \`\`\`typescript fence — the whole file, not a diff.`;

            const codeResult = await services.singleTurn({ provider: codeProvider, prompt, signal: ctx.signal });
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

            const tc = await checkProjectDir(buildDir);
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
          // not a throw — so don't trust the message text, verify the effect: the plugin took hold only
          // if the compiled tool is now resolvable. (On the reload path a still-resolvable OLD version
          // can mask a cancelled reload — the registry can't distinguish that; accepted.) Without this
          // check a cancelled install reported `installed` and hid the source skill.
          if (!alreadyInstalled && !services.tools.resolve(toolName)) {
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
