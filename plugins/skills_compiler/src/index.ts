import { PLUGIN_API_VERSION, currentPrincipal, invokeTool, toolText } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolEvent, ToolContext, Session, Message } from '@matatbread/matbot-plugin-api';

// Loose discovery of the skills plugin's SkillManager — optional, so no hard dependency on the
// package. Only the slice this tool consumes is declared.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SkillManager?: { get(name: string): { content: string } | undefined };
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
}

// LLM call. Resolves once; no streaming. Use for any "reason about" / "summarise" / "decide" step.
services.singleTurn(req: { provider: string; prompt: string; system?: string; signal?: AbortSignal })
  => Promise<{ text: string; usage?: unknown }>;

// Call another registered tool by name and collapse its event stream to a string result.
invokeTool(services, name: string, params: unknown,
           opts: { session: Session; signal: AbortSignal; provider?: string }): AsyncIterable<ToolEvent>;
toolText(events: AsyncIterable<ToolEvent>): Promise<string>;   // throws on the tool's first error event

// HTTP is the Web fetch() — no node http, no axios. JSON parsing/maths/dates/etc. are plain JS.`;

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

          yield { type: 'progress', pct: 15, message: `Classifying...` };
          const classResult = await services.singleTurn({
            provider: codeProvider,
            prompt: `Classify as "procedural" or "knowledge". Procedural: steps, workflows, branching, input-process-output. Knowledge: reference, narratives, facts to read.\n\nSkill: ${skill}\n---\n${skillContent}\n---\n\n{"classification":"procedural"|"knowledge","reasoning":"..."}`,
            signal: ctx.signal,
          });

          let classification: string;
          let classReason: string;
          try {
            const m = classResult.text.match(/\{[\s\S]*\}/);
            const parsed = m ? JSON.parse(m[0]) : null;
            classification = parsed?.classification ?? '';
            classReason = parsed?.reasoning ?? '';
          } catch { classification = ''; classReason = ''; }

          if (!classification) {
            const hasSteps = (skillContent.match(/^\d+\.\s/gm) || []).length >= 3;
            classification = hasSteps ? 'procedural' : 'knowledge';
            classReason = `heuristic: ${hasSteps ? 'numbered steps' : 'no numbered steps'}`;
          }

          if (classification !== 'procedural') {
            yield { type: 'result', value: { status: 'not_compilable', skill, classification, reasoning: classReason } };
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

          yield { type: 'progress', pct: 80, message: 'Generating code...' };

          const safeName = sanitise(skill);
          const pluginPkgName = `@matatbread/matbot-tool-${safeName}`;
          const pluginDir = `plg_${safeName}`;
          const toolName = design.toolName as string;
          const toolDesc = (design.toolDescription as string).replace(/`/g, '\\`');
          const toolParams = (design.parameters || []) as Array<{name: string; type: string; description: string; required: boolean}>;

          const packageJson = JSON.stringify({
            name: pluginPkgName, matbotRuntime: ["node"], version: "0.1.0", type: "module",
            exports: { ".": "./src/index.ts" }, files: ["src"],
            peerDependencies: { "@matatbread/matbot-plugin-api": "workspace:^" },
          }, null, 2);

          const tsconfigJson = JSON.stringify({
            compilerOptions: {
              target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext",
              strict: true, esModuleInterop: true, skipLibCheck: true,
              outDir: "dist", rootDir: "src",
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
import { PLUGIN_API_VERSION, invokeTool, toolText } from '@matatbread/matbot-plugin-api';
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

Rules: implement the SPEC, using the worked example's exact URLs/queries/field names to remove ambiguity. Reproduce only the steps that meet the spec — never the example's exploratory or discovery calls. Drive everything off the tool's input parameters; treat the example's specific values as illustrative, not constants (except genuine endpoints/queries the spec implies are fixed). Pass ctx.signal through every fetch/singleTurn/invokeTool. Yield progress/result/error events. Output ONLY src/index.ts in a typescript fence.`;

          const codeResult = await services.singleTurn({
            provider: codeProvider,
            prompt: codeGenPrompt,
            signal: ctx.signal,
          });

          let indexSource: string;
          const tsMatch = codeResult.text.match(/```(?:typescript|ts)\s*\n([\s\S]*?)```/) ||
                         codeResult.text.match(/```\s*\n([\s\S]*?)```/);
          indexSource = tsMatch ? tsMatch[1]!.trim() : codeResult.text.trim();
          if (!indexSource.startsWith('import')) {
            const i = indexSource.indexOf('\nimport ');
            if (i >= 0) indexSource = indexSource.slice(i + 1);
          }
          if (!indexSource.includes('MatbotPluginSpec')) {
            yield { type: 'error', message: `Invalid generated code. Preview: ${indexSource.slice(0, 500)}` };
            return;
          }

          const files: Record<string, string> = { "package.json": packageJson, "tsconfig.json": tsconfigJson, "src/index.ts": indexSource };

          // Write the generated plugin into the workspace via workspace_action — no hardcoded path.
          // Workspace files land under <project>/.data/files/<path>, inside the project tree, so both
          // tsc and the runtime loader resolve @matatbread/* by walking up to the host node_modules:
          // no symlink, no machine-specific path.
          if (!services.configPath) {
            yield { type: 'error', message: 'No configPath available; cannot locate the workspace on disk to typecheck.' };
            return;
          }
          const wsRoot = `skill_compiler/${pluginDir}`;
          yield { type: 'progress', pct: 88, message: 'Writing plugin to workspace...' };
          try {
            for (const [rel, content] of Object.entries(files)) {
              await toolText(invokeTool(services, 'workspace_action',
                { action: 'write', path: `${wsRoot}/${rel}`, content },
                { session: ctx.session, signal: ctx.signal }));
            }
          } catch (e) {
            yield { type: 'error', message: `Could not write plugin to workspace: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }

          const { dirname, join } = await import('node:path');
          const buildDir = join(dirname(services.configPath), '.data', 'files', 'skill_compiler', pluginDir);

          yield { type: 'progress', pct: 93, message: 'Typechecking...' };
          let typecheckOk = false;
          let typecheckOutput = '';
          try {
            const { execSync } = await import('node:child_process');
            execSync('npx tsc --noEmit', { cwd: buildDir, timeout: 60_000, stdio: 'pipe' });
            typecheckOk = true;
          } catch (e: any) {
            typecheckOutput = ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim() || String(e);
          }

          if (!typecheckOk) {
            yield { type: 'progress', pct: 100, message: 'Done — typecheck failed.' };
            yield {
              type: 'result',
              value: {
                status: 'typecheck_failed', skill, toolName, workspaceDir: wsRoot,
                method, excluded: design.excluded, typecheckOutput: typecheckOutput.slice(0, 2000),
              },
            };
            return;
          }

          // Install it. `plugin add` is human-confirmation-gated by design, so forward ctx.prompt; the
          // specifier is the local workspace dir (./-relative ⇒ classified 'local', package.json present)
          // so it persists portably in matbot.yaml.
          const specifier = `./.data/files/skill_compiler/${pluginDir}`;
          yield { type: 'progress', pct: 97, message: 'Installing plugin...' };
          let installMessage: string;
          try {
            installMessage = await toolText(invokeTool(services, 'plugin',
              { action: 'add', specifier },
              { session: ctx.session, signal: ctx.signal, prompt: ctx.prompt }));
          } catch (e) {
            yield {
              type: 'result',
              value: {
                status: 'compiled_not_installed', skill, toolName, pluginName: pluginPkgName,
                workspaceDir: wsRoot, specifier, typecheckOk, method, excluded: design.excluded,
                installError: e instanceof Error ? e.message : String(e),
              },
            };
            return;
          }

          yield { type: 'progress', pct: 100, message: 'Done — compiled, typechecked, installed.' };
          yield {
            type: 'result',
            value: {
              status: 'installed', skill, classification: 'procedural', reasoning: classReason,
              toolName, pluginName: pluginPkgName, workspaceDir: wsRoot, specifier, typecheckOk,
              method, excluded: design.excluded, install: installMessage,
            },
          };
        },
      };

      services.tools.register({
        name: 'skill_compiler',
        description: `Compile a procedural markdown skill into an executable TypeScript plugin, then install it.

Methodology: load from SkillManager → classify (only procedural skills compile) → demonstrate in a scratch session capturing the real working trace → distil the trace to the method that worked → generate TypeScript → write into the workspace → typecheck with tsc → install via the plugin tool (asks for confirmation).

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
