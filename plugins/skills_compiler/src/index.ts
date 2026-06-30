import { PLUGIN_API_VERSION, currentPrincipal, invokeTool, toolResult, toolText } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext, Session, Message } from '@matatbread/matbot-plugin-api';
import { buildMatbotToolsDts } from './build-matbot-dts.js';

// Loose discovery of the skills plugin's SkillManager — optional, so no hard dependency on the
// package. Only the slice this tool consumes is declared.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SkillManager?: {
      get(name: string): {
        content: string;
        knowledge?: { classification: { procedural: number; informational: number } };
      } | undefined;
    };
  }
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/_+/g, '_');
}

// The exact, whitelisted API surface a compiled plugin may use against its environment. Given to the
// codegen pass verbatim so it builds against real signatures rather than guessing — and so it knows it
// has nothing else: HTTP is `fetch`, an LLM call is `services.singleTurn`, another tool is `invokeTool`
// + `toolText`, everything else is plain JS.
const MACHINE_API = `// --- Environment API available to the generated plugin (and nothing beyond it) ---
type ToolEvent =
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: unknown }
  | { type: 'error';    message: string };

interface ToolContext {
  callId:    string;
  session:   Session;            // pass to invokeTool's opts.session
  signal:    AbortSignal;        // pass to fetch / singleTurn / invokeTool so the tool is cancellable
  provider?: string;             // the turn's LLM provider key; default singleTurn to this
  prompt?:   PromptFn;           // interactive prompt channel from the calling turn; pass to invokeTool so interactive tools (ask_user) can reach the user
}

// LLM call. Resolves once; no streaming. Use for any "reason about" / "summarise" / "decide" step.
services.singleTurn(req: { provider: string; prompt: string; system?: string; signal?: AbortSignal })
  => Promise<{ text: string; usage?: unknown }>;

// Call another registered tool by name. Pass the executor's OWN ctx straight through as the 4th
// argument — session, signal, prompt AND provider all propagate, so a callee that needs an LLM
// (find_fact, or anything using singleTurn) inherits this turn's provider. Never hand-pick a subset
// like { session, signal }; that is how the provider gets dropped and the callee fails with "no provider".
invokeTool(services, name: string, params: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<Result>>;

// Read a tool's result. Two readers — pick by what the tool returns:
toolResult(events): Promise<Result>;   // the STRUCTURED result value, already typed by the tool name.
toolText(events):   Promise<string>;   // the result collapsed to a string (prose tools, or plain text).
// Both throw on the tool's first error event. Prefer toolResult for any tool that returns data — it is
// typed, so you get real fields and the compiler catches misuse. NEVER JSON.parse a toolText string and
// NEVER regex a value out of prose. Known result types (toolResult gives these, fully typed):
//   find_fact          => string[] | null                      // matching facts, or null if none found
//   ask_user           => { name: string; answer: string }     // answer = typed text / chosen option / "Yes"|"No"
//   contextual_search  => { name: string; content: string }    // a whole knowledge document to read
// Single specific datum (a city, id, threshold) → find_fact, NOT contextual_search. Forward ctx:
//   const facts = await toolResult(invokeTool(services, 'find_fact',
//     { question: string, terms: [{ term: string, context?: string }] }, ctx));   // facts: string[] | null
//   const a = await toolResult(invokeTool(services, 'ask_user', { name, label, type: 'text' }, ctx)); // a.answer
// For any other tool the result is "unknown" — narrow it before use (the compiler will force you to).

// HTTP is the Web fetch() — no node http, no axios. JSON parsing/maths/dates/etc. are plain JS.`;

// Augments the generated plugin's view of `ToolResults` so `toolResult(invokeTool(..., name, ...))` is
// typed for the common tools it calls. The real augmentations live in those tools' own packages
// (ask-user, rumsfeld), but the generated plugin is a separate compilation that only sees plugin-api —
// so we ship this alongside it. Keep in step with those packages' ToolResults declarations.
const TOOL_RESULTS_DTS = `import '@matatbread/matbot-plugin-api';
declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    ask_user: { name: string; answer: string };
    find_fact: string[] | null;
    contextual_search: { name: string; content: string };
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
      const executor: ToolExecutor = {
        async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const { skill, provider: explicitProvider } = input as { skill: string; provider?: string };
          if (!skill || typeof skill !== 'string') {
            yield { type: 'error', message: 'Parameter "skill" is required.' };
            return;
          }

          const codeProvider = explicitProvider || ctx.provider;
          if (!codeProvider) {
            yield { type: 'error', message: 'No provider available.' };
            return;
          }

          yield { type: 'progress', pct: 10, message: `Loading "${skill}"...` };
          const doc = services.SkillManager?.get(skill);
          if (!doc) {
            yield { type: 'result', value: { status: 'not_found', message: `Skill "${skill}" not found.` } };
            return;
          }
          const skillContent = doc.content;

          // The procedural/informational split is derived once by the skills metadata pass and cached
          // on the doc — we read it rather than re-classify. Absent only until that pass has run (it is
          // detached from the save, and the no-provider/failure path persists nothing): re-saving the
          // skill regenerates it. Only a primarily-procedural skill describes a method to compile.
          const classification = doc.knowledge?.classification;
          if (!classification) {
            yield { type: 'result', value: { status: 'no_metadata', skill, message: `Skill "${skill}" has no derived classification yet. Re-save the skill to generate its metadata, then retry.` } };
            return;
          }
          if (classification.procedural <= classification.informational) {
            yield { type: 'result', value: { status: 'not_compilable', skill, classification } };
            return;
          }

          yield { type: 'progress', pct: 30, message: `Executing "${skill}"...` };
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
            ownerPrincipalId: principal.id,
            status: 'active',
            contexts: [],
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
              content: [{
                type: 'text',
                origin: 'robo',
                text: `Follow the instructions in the skill "${skill}". Apply them now — they take precedence over brevity.\n\n${skillContent}`,
              }],
              provider: codeProvider,
              principal,
            });

            for await (const ev of view.events) {
              if (!('traceId' in ev) || ev.traceId !== view.traceId) continue;
              if (ev.type === 'done' || ev.type === 'aborted') { finalSession = ev.session; break; }
              if (ev.type === 'error') break;
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

          yield { type: 'progress', pct: 60, message: `Captured ${finalSession.messages.length} messages, ${toolCalls.length} tool calls.` };

          yield { type: 'progress', pct: 70, message: 'Distilling working method...' };
          const distillResult = await services.singleTurn({
            provider: codeProvider,
            system: `You analyse a trace of an AI agent working out how to perform a task. The trace interleaves the agent's reasoning ([THINKING]), narration ([SAYS]), tool calls ([CALLS]) and results ([RESULT]). Agents explore: they run discovery calls (listing plugins/servers, searching for context), make false starts, and hit dead-ends before finding what actually produces the answer. Extract the MINIMAL CORRECT METHOD — only the steps on the path that worked — and inline what discovery taught (a concrete URL, query, threshold or field name learned mid-run) as constants rather than re-deriving it. Discard every exploratory or incorrect step.`,
            prompt: `Skill being performed:\n${skillContent}\n\n--- AGENT TRACE ---\n${transcript}\n--- END TRACE ---\n\nReturn ONLY JSON:\n{"toolName":"snake_case","toolDescription":"one line","parameters":[{"name":"...","type":"string|number|boolean","description":"...","required":true|false}],"method":"Numbered, ordered steps the compiled tool must perform, with the exact mechanism for each: an HTTP step gives method + URL + body with discovered constants inlined; a tool step gives the tool name and exact args; a compute step gives the JS data-processing logic lifted from the reasoning. Exclude every exploratory/discovery/dead-end step.","excluded":["one short note per discarded exploratory step and why"]}`,
            signal: ctx.signal,
          });

          let design: any = { toolName: sanitise(skill), toolDescription: `Compiled from "${skill}"`, parameters: [], method: transcript, excluded: [] };
          try { const m = distillResult.text.match(/\{[\s\S]*\}/); if (m) design = { ...design, ...JSON.parse(m[0]) }; } catch {}
          const method: string = typeof design.method === 'string' && design.method.trim() ? design.method : transcript;

          yield { type: 'progress', pct: 80, message: 'Preparing build...' };

          const safeName = sanitise(skill);
          const pluginPkgName = `@matatbread/matbot-compiled-${safeName}`;
          const pluginDir = safeName;
          const toolName = design.toolName as string;
          const toolDesc = (design.toolDescription as string).replace(/`/g, '\\`');
          const toolParams = (design.parameters || []) as Array<{name: string; type: string; description: string; required: boolean}>;

          const packageJson = JSON.stringify({
            name: pluginPkgName, matbotRuntime: ["node"], version: "0.1.0", type: "module",
            exports: { ".": "./src/index.ts" }, files: ["src"],
            peerDependencies: { "@matatbread/matbot-plugin-api": "workspace:^" },
          }, null, 2);

          // Compute relative paths from the plugin build dir to tsconfig.base.json and the plugin-api
          // package at the project root. The build dir is <projectRoot>/<COMPILED_PLUGINS_DIR>/<name>/
          // which is outside the pnpm workspace packages, so tsc needs explicit paths to resolve the peer dep.
          const { dirname: tsDirname, join: tsJoin, relative: tsRelative } = await import('node:path');
          const projectRoot = tsDirname(services.configPath!);
          const pluginBuildDir = tsJoin(projectRoot, COMPILED_PLUGINS_DIR, pluginDir);
          const baseTsconfigPath = tsRelative(pluginBuildDir, tsJoin(projectRoot, 'tsconfig.base.json'));
          const pluginApiPath = tsRelative(pluginBuildDir, tsJoin(projectRoot, 'plugin-api', 'src', 'index.ts'));
          const tsconfigJson = JSON.stringify({
            extends: baseTsconfigPath,
            compilerOptions: {
              paths: { "@matatbread/matbot-plugin-api": [pluginApiPath] },
              declaration: false, declarationMap: false, sourceMap: false,
            },
            include: ["src/**/*"],
          }, null, 2);

          const reqd = toolParams.filter(p => p.required).map(p => JSON.stringify(p.name)).join(', ');
          const props = JSON.stringify(Object.fromEntries(toolParams.map(p => [p.name, { type: p.type, description: p.description }]))) || '{}';

          const codeGenPrompt = `Generate TypeScript for a matbot plugin that implements the following skill as a deterministic tool.

THE SPECIFICATION — this is what the tool must achieve. It is authoritative:
--- SKILL "${skill}" ---
${skillContent}
--- END SKILL ---

A WORKED EXAMPLE — one real run of an agent performing the skill, distilled to the path that worked (exploration and dead-ends already removed). Treat it as pseudo-code that disambiguates the spec: it pins down the concrete URLs, queries, field names, thresholds and ordering the prose leaves open. It is ONE execution, not the only one — implement the spec's general method, using this to resolve ambiguity and fill gaps, not as inputs to hard-code:
--- DISTILLED METHOD ---
${method}
--- END METHOD ---

${MACHINE_API}

Template (fill IMPLEMENTATION):
\`\`\`ts
import { PLUGIN_API_VERSION, invokeTool, toolResult, toolText } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  async setup(services: MatbotMachine) {
    const executor: ToolExecutor = {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
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

Rules: implement the SPEC, using the worked example's exact URLs/queries/field names to remove ambiguity. Reproduce only the steps that meet the spec — never the example's exploratory or discovery calls. Implement EVERY branch the spec describes — each arm of an if/else, each conditional path — even when the worked example exercised only one. The example is a single trace through the spec; the spec defines all the paths. E.g. if Step 1 says "if no result, ask for free text; if more than one result, present a choice", implement both the text ask_user and the select ask_user, not just whichever the example happened to hit. Drive everything off the tool's input parameters; treat the example's specific values as illustrative, not constants (except genuine endpoints/queries the spec implies are fixed). Pass ctx.signal through every fetch/singleTurn/invokeTool. When calling another tool, forward the executor's whole ctx as invokeTool's 4th argument — invokeTool(services, name, params, ctx) — so session, signal, prompt AND provider propagate; never pass a hand-picked { session, signal } object, or a callee that needs an LLM (find_fact, singleTurn-based tools) will fail with "no provider". Yield progress/result/error events. NEVER extract a value from another tool's natural-language output with a regex or fixed-phrase string match (e.g. searchResult.match(/the location is (.+)/)) — that assumes an exact wording the tool will not reliably produce, so it silently fails. When a step needs a specific stored fact, use the find_fact tool (structured JSON { found, fact }), NOT contextual_search followed by string-parsing of its prose; if the spec names contextual_search for what is really a single-fact lookup, translate it to find_fact. Parse any tool result defensively — handle missing or differently-shaped data rather than assuming one rigid format. The project enforces strict TypeScript: verbatimModuleSyntax — use \ for type-only imports and \ for value imports; never use bare default imports unless the module has a real default export. The project also enables exactOptionalPropertyTypes — when a property is optional (key?: T), never pass undefined explicitly; omit the key instead. It enables noUncheckedIndexedAccess — array indexing returns T | undefined, so guard every array[i] access before using it. Output ONLY src/index.ts in a typescript fence.`;

          // Write the plugin straight to disk with node:fs — NOT via workspace_action. The workspace is
          // the user's artifact space, and routing build files through it created a hidden dependency on
          // the workspace plugin (compile would fail if it wasn't loaded) plus a false assumption that the
          // file store materialises on the local filesystem. The build needs a real local path it owns.
          // The static files and the peer-dep symlink don't change between repair passes; only
          // src/index.ts is regenerated.
          if (!services.configPath) {
            yield { type: 'error', message: 'No configPath available; cannot locate the project root on disk.' };
            return;
          }
          const { dirname, join } = await import('node:path');
          const relDir   = `${COMPILED_PLUGINS_DIR}/${pluginDir}`;
          const buildDir = join(dirname(services.configPath), COMPILED_PLUGINS_DIR, pluginDir);

          const { mkdir, symlink, readlink, writeFile } = await import('node:fs/promises');

          // Derive the tool-result / service types from the LIVE loaded plugins so the generated plugin
          // gets correct `toolResult` types and typed `services.*` for everything it can reach. The set
          // of plugins (and where their source lives) comes from the `plugin` tool's `list` — going via
          // the tool keeps it replaceable and matches what the LLM sees. Falls back to a monorepo glob,
          // then to the static DTS, when the live set or sources aren't available.
          yield { type: 'progress', pct: 84, message: 'Deriving tool result types...' };
          let toolResultsDts = TOOL_RESULTS_DTS;
          try {
            let pluginUrls: string[] = [];
            try {
              const list = await toolResult(invokeTool(services, 'plugin', { action: 'list' }, ctx)) as { loaded?: Array<{ resolvedUrl?: string }> };
              pluginUrls = (list.loaded ?? []).map(p => p.resolvedUrl).filter((u): u is string => typeof u === 'string');
            } catch { /* `plugin` tool absent → buildMatbotToolsDts falls back to the monorepo glob */ }
            const generated = await buildMatbotToolsDts(dirname(services.configPath), pluginUrls);
            if (generated) {
              toolResultsDts = generated.dts;
              yield { type: 'progress', pct: 85, message: `Typed ${generated.tools.emitted.length} tool result(s) and ${generated.services.emitted.length} service(s).` };
            }
          } catch { /* keep the static fallback */ }

          yield { type: 'progress', pct: 85, message: 'Writing plugin scaffold...' };
          try {
            await mkdir(join(buildDir, 'src'), { recursive: true });
            await writeFile(join(buildDir, 'package.json'), packageJson);
            await writeFile(join(buildDir, 'tsconfig.json'), tsconfigJson);
            await writeFile(join(buildDir, 'src', 'matbot-tools.d.ts'), toolResultsDts);
          } catch (e) {
            yield { type: 'error', message: `Could not write plugin to ${relDir}: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          // node_modules symlink so Node's ESM resolver finds the peer dep at runtime — the build dir is
          // outside the pnpm workspace packages, so it has no node_modules of its own.
          const linkDir = join(buildDir, 'node_modules', '@matatbread');
          const linkPath = join(linkDir, 'matbot-plugin-api');
          const linkTarget = join(dirname(services.configPath), 'plugin-api');
          try {
            await mkdir(linkDir, { recursive: true });
            try { await readlink(linkPath); } catch { await symlink(linkTarget, linkPath); }
          } catch (e) {
            yield { type: 'error', message: `Could not create node_modules symlink: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          // Generate → typecheck → on failure feed the tsc errors + current code back for repair, up to
          // MAX_PASSES. The repair loop OWNS the broken file so the calling LLM never has to find or patch
          // it by hand; only after the loop gives up do we surface the errors as a result.
          // Typecheck via the real `tsc` binary (typescript is a dependency, so resolve its bin — no
          // npx) as an AWAITED async subprocess. A synchronous typecheck — execSync, or an in-process
          // createProgram — is CPU-heavy enough to block the event loop and freeze the web UI for its
          // whole duration; an async child process keeps the loop free while it compiles.
          const { createRequire } = await import('node:module');
          const requireFrom = createRequire(import.meta.url);
          const tscBin = join(dirname(requireFrom.resolve('typescript')), '..', 'bin', 'tsc');
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          const runTypecheck = async (): Promise<{ ok: boolean; output: string }> => {
            try {
              await execFileAsync(process.execPath, [tscBin, '--noEmit'],
                { cwd: buildDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
              return { ok: true, output: '' };
            } catch (e: any) {
              const out = ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim();
              return { ok: false, output: out || String(e) };
            }
          };
          const MAX_PASSES = 3;
          const extractSource = (text: string): string => {
            const m = text.match(/```(?:typescript|ts)\s*\n([\s\S]*?)```/) || text.match(/```\s*\n([\s\S]*?)```/);
            let src = m ? m[1]!.trim() : text.trim();
            if (!src.startsWith('import')) {
              const i = src.indexOf('\nimport ');
              if (i >= 0) src = src.slice(i + 1);
            }
            return src;
          };

          let indexSource = '';
          let typecheckOk = false;
          let typecheckOutput = '';
          let pass = 0;
          for (pass = 1; pass <= MAX_PASSES && !typecheckOk; pass++) {
            yield { type: 'progress', pct: 86 + pass * 3, message: pass === 1 ? 'Generating code...' : `Typecheck failed — repairing (pass ${pass}/${MAX_PASSES})...` };

            const prompt = pass === 1 ? codeGenPrompt :
`The TypeScript you generated for this plugin does not compile. Return a corrected version.

${MACHINE_API}

--- CURRENT src/index.ts ---
${indexSource}
--- END CURRENT ---

--- \`tsc --noEmit\` ERRORS ---
${typecheckOutput}
--- END ERRORS ---

Fix every reported error. Change only what each error requires; keep the tool name, inputs and behaviour identical. Remember verbatimModuleSyntax (use \`import type\` for type-only imports), exactOptionalPropertyTypes (omit an optional key rather than passing undefined), and noUncheckedIndexedAccess (guard every array[i] before use). Output ONLY the complete corrected src/index.ts in a single \`\`\`typescript fence — the whole file, not a diff.`;

            const codeResult = await services.singleTurn({ provider: codeProvider, prompt, signal: ctx.signal });
            const src = extractSource(codeResult.text);
            if (!src.includes('MatbotPluginSpec')) {
              typecheckOutput = 'Your reply did not contain a valid plugin (no MatbotPluginSpec found). Output ONLY the complete src/index.ts in a single ```typescript fence.';
              continue;
            }
            indexSource = src;

            try {
              await writeFile(join(buildDir, 'src', 'index.ts'), indexSource);
            } catch (e) {
              yield { type: 'error', message: `Could not write ${relDir}/src/index.ts: ${e instanceof Error ? e.message : String(e)}` };
              return;
            }

            const tc = await runTypecheck();
            if (tc.ok) typecheckOk = true;
            else typecheckOutput = tc.output.trim() || 'typecheck failed';
          }

          if (!typecheckOk) {
            yield { type: 'progress', pct: 100, message: `Done — typecheck failed after ${MAX_PASSES} passes.` };
            yield {
              type: 'result',
              value: {
                status: 'typecheck_failed', skill, toolName, dir: relDir, passes: MAX_PASSES,
                method, excluded: design.excluded, typecheckOutput: typecheckOutput.slice(0, 2000),
              },
            };
            return;
          }

          // Install it via the `plugin` tool — but only if it's loaded. Installing (persisting to
          // matbot.yaml + loading) is the plugin tool's job, a soft dependency: if it isn't present, the
          // plugin is fully built on disk, so report compiled_not_installed with the specifier rather than
          // failing. `plugin add` is human-confirmation-gated, so forward ctx.prompt (via ctx); the
          // specifier is the local dir (./-relative ⇒ classified 'local', package.json present) so it
          // persists portably in matbot.yaml.
          const specifier = `./${relDir}`;
          if (!services.tools.resolve('plugin')) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName,
                dir: relDir, specifier, typecheckOk, method, excluded: design.excluded,
                installError: 'The `plugin` management tool is not loaded; install it manually with: plugin add ' + specifier,
              },
            };
            return;
          }
          yield { type: 'progress', pct: 97, message: 'Installing plugin...' };
          let installMessage: string;
          try {
            installMessage = await toolText(invokeTool(services, 'plugin',
              { action: 'add', specifier },
              ctx));
          } catch (e) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName,
                dir: relDir, specifier, typecheckOk, method, excluded: design.excluded,
                installError: e instanceof Error ? e.message : String(e),
              },
            };
            return;
          }

          // Rewire any triggers that fired the *skill* (`skill_action(use, <skill>)`) onto the new tool, so
          // the deterministic tool answers the condition instead of the skill prose being injected. Soft
          // dependency on `trigger_action` (orthogonal subsystem): if it isn't loaded, skip silently.
          let movedTriggers: { id: string }[] = [];
          if (services.tools.resolve('trigger_action')) {
            try {
              const moved = await toolResult(invokeTool(services, 'trigger_action',
                { action: 'move', tool: 'skill_action', params: { action: 'use', name: skill }, toTool: toolName },
                ctx)) as { triggers?: { id: string }[] };
              movedTriggers = moved.triggers ?? [];
            } catch { /* fails soft — install already succeeded */ }
          }

          yield { type: 'progress', pct: 100, message: 'Done — compiled, typechecked, installed.' };
          yield {
            type: 'result',
            value: {
              status: 'installed', skill, classification, passes: pass - 1,
              toolName, pluginName: pluginPkgName, dir: relDir, specifier, typecheckOk,
              method, excluded: design.excluded, install: installMessage,
              movedTriggers: movedTriggers.map(t => t.id),
            },
          };
        },
      };

      services.tools.register({
        name: 'skill_compiler',
        description: `Compile a procedural markdown skill into an executable TypeScript plugin, then install it.

Methodology: load from SkillManager → classify (only procedural skills compile) → demonstrate in a scratch session capturing the real working trace → distil the trace to the method that worked → generate TypeScript → write to ${COMPILED_PLUGINS_DIR}/ → typecheck with tsc, feeding any errors back to the code generator to self-repair (up to 3 passes) → install via the plugin tool (asks for confirmation).

Compiled plugins use: fetch() for HTTP, services.singleTurn() for LLM, invokeTool() for tools, plain JS for logic.`,
        inputSchema: {
          type: 'object',
          required: ['skill'],
          properties: {
            skill: { type: 'string', description: 'Skill name from SkillManager.' },
            provider: { type: 'string', description: 'Optional code-gen provider. Defaults to turn provider.' },
          },
        },
        executor,
      });
    },
  };
}

export const plugin: MatbotPluginSpec = createSkillCompilerPlugin();
