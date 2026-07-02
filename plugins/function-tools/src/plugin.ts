import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  JSONSchema, MatbotMachine, MatbotPluginSpec, PluginSettings,
  Tool, ToolContext, ToolEvent, ToolResult, ToolResultOf,
} from '@matatbread/matbot-plugin-api';
import { buildAsyncFn, runFunction, type CompiledFn } from './compile.js';
import { parseSignature, paramsSchema, type ParsedParam, type ParsedSignature } from './signature.js';

const TOOL_NAME   = 'tool_function';
const PLUGIN_NAME = 'function-tools';
const STORE_KEY   = 'functions';

interface FunctionRecord { name: string; definition: string; description?: string }

// Placeholder used as a defined tool's description when the caller supplies none — fill in as desired.
const PLACEHOLDER_DESCRIPTION = 'A user-defined function tool.';

/** The params object's TypeScript type as text — one property per parameter (optional ⇒ `?`). */
function paramsTypeText(params: ParsedParam[]): string {
  return params.length === 0
    ? '{}'
    : `{ ${params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type ?? 'unknown'}`).join('; ')} }`;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    tool_function:
      | ToolResult<{ message: string; tool: string; parameters: ParsedParam[] }, { action: 'define' }>
      | ToolResult<unknown,                                                      { action: 'lambda' }>
      | ToolResult<{ functions: FunctionRecord[] },                             { action: 'list'   }>
      | ToolResult<{ available: boolean; dts: string },                         { action: 'types'  }>
      | ToolResult<{ message: string },                                         { action: 'remove' }>;
  }
}

type ToolFunctionAction =
  | { action: 'define'; definition: string; description?: string }
  | { action: 'lambda'; definition: string; params?: unknown }
  | { action: 'list' }
  | { action: 'types' }
  | { action: 'remove'; name: string };

/** Owns the defined functions: derives+compiles each into a registered tool, and persists the sources. */
class FunctionStore {
  private readonly machine:  MatbotMachine;
  private readonly settings: PluginSettings;
  private readonly defined = new Map<string, FunctionRecord>();

  constructor(machine: MatbotMachine, settings: PluginSettings) {
    this.machine  = machine;
    this.settings = settings;
  }

  async reload(): Promise<void> {
    const persisted = await this.settings.get<{ functions: FunctionRecord[] }>(STORE_KEY);
    for (const rec of persisted?.functions ?? []) {
      try { await this.registerTool(rec); this.defined.set(rec.name, rec); }
      catch (e) { console.warn(`[${PLUGIN_NAME}] skipping "${rec.name}": ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  list(): FunctionRecord[] { return [...this.defined.values()]; }

  async define(definition: string, description?: string): Promise<{ name: string; parameters: ParsedParam[] }> {
    const sig = parseSignature(definition);
    if (sig.name === undefined) throw new Error('define requires a NAMED function, e.g. `weather(city: string): string { … }`.');
    if (sig.name === TOOL_NAME) throw new Error(`"${TOOL_NAME}" is reserved.`);
    const clash = this.machine.tools.resolve(sig.name);
    if (clash !== null && !this.defined.has(sig.name)) {
      throw new Error(`A tool named "${sig.name}" already exists and wasn't defined here — choose another name.`);
    }
    // Type-check the body against the live tool types before registering (node only; skipped when the
    // ToolTypeIndex service is absent, e.g. the browser — the function still compiles and runs).
    const index = this.machine.ToolTypeIndex;
    if (index !== undefined) {
      const ret     = sig.returnType ?? 'unknown';
      const retType = /^Promise\s*</.test(ret) ? ret : `Promise<${ret}>`;
      const diags   = await index.check(`async function __fn(${sig.paramsText}): ${retType} ${sig.body}`);
      if (diags.length > 0) throw new Error(`type error(s) — fix and re-define:\n${diags.join('\n')}`);
    }
    const rec: FunctionRecord = {
      name: sig.name,
      definition,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
    };
    await this.registerTool(rec);      // compiles; throws on bad source before anything is persisted
    this.defined.set(sig.name, rec);
    await this.persist();
    return { name: sig.name, parameters: sig.params };
  }

  async remove(name: string): Promise<boolean> {
    if (!this.defined.has(name)) return false;
    this.machine.tools.remove(name);
    this.machine.ToolTypeIndex?.retract(name);
    this.defined.delete(name);
    await this.persist();
    return true;
  }

  removeAll(): void {
    const index = this.machine.ToolTypeIndex;
    for (const name of this.defined.keys()) { this.machine.tools.remove(name); index?.retract(name); }
  }

  private async registerTool(rec: FunctionRecord): Promise<void> {
    const sig        = parseSignature(rec.definition);
    const paramNames = sig.params.map(p => p.name);
    const fn: CompiledFn = await buildAsyncFn(this.machine.TypeScriptStripper, rec.definition, paramNames);
    const machine = this.machine;
    const tool: Tool = {
      name:        rec.name,
      description: `${rec.description ? rec.description : (`${PLACEHOLDER_DESCRIPTION}\n\nSource:\n${rec.definition}`)}\n\nDefined via ${TOOL_NAME}.`,
      inputSchema: paramsSchema(sig.params),
      paramsType:  paramsTypeText(sig.params),
      resultType:  sig.returnType ?? 'unknown',
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
    this.contributeTypes(sig, rec.name);
  }

  // Feed this (already type-checked) function's result + param types into the ToolTypeIndex, so a later
  // function composing `await tool.<name>(…)` sees real types. Runs for both define and reload; idempotent.
  private contributeTypes(sig: ParsedSignature, name: string): void {
    const index = this.machine.ToolTypeIndex;
    if (index === undefined) return;
    index.contribute(name, { result: sig.returnType ?? 'unknown', params: paramsTypeText(sig.params) });
  }

  private async persist(): Promise<void> {
    await this.settings.set(STORE_KEY, { functions: [...this.defined.values()] });
  }
}

const DESCRIPTION = `Compose multiple tool calls — filter, count, reshape their results — without routing every intermediate result
back through the model. Compositions is expressed as TypeScript functions that orchestrate other tools in a single pass.

Inside a function, call any registered tool through the injected \`tool\` proxy:
\`const r = await tool.<tool_name>(params)\` runs that tool and resolves to its structured result (the
same value a direct call yields). Every tool call MUST be awaited — the whole body runs as an async
function (so a recursive self-call must be awaited too). Return a JSON-serialisable value; that becomes
the result the model sees. Each tool call is echoed to stdout, so the run is observable.

Before composing, run \`{ action: 'types' }\` to fetch TypeScript declarations of what the available tools'
calls resolve to — write \`await tool.x(...)\` against those real return types instead of guessing shapes.

ACTIONS
  define — Persist a NAMED function and register it as a new tool of the same name. Parameters are
           derived from the signature and become the tool's inputs. Pass an optional \`description\` to
           document the new tool (shown to the model). Survives restart. Re-defining the same name
           recompiles it. Never shadows a tool you didn't define here. Note: tools defined this way become
           visible on the *next turn*.
  lambda — Compile and run an ANONYMOUS one-argument function once, now, against \`params\`. Nothing is
           persisted or registered.
  list   — Show the functions you've defined, with their source.
  types  — Return TypeScript declarations (a .d.ts) of what the available tools' calls resolve to, so you
           can compose against real return types. Node only; \`available: false\` with an empty dts where
           type info can't be derived (e.g. the browser) — fall back to inferring shapes and testing.
  remove — Delete a defined function and unregister its tool.

Functions use method-shorthand syntax — NOT arrow functions:

  define (definition):
    count_plugins(check: string): string {
      const p = await tool.plugin({ action: 'list' });
      const n = p.loaded.filter(pl => pl.name.includes(check)).length;
      return n + ' plugins match "' + check + '"';
    }
  → registers tool "count_plugins" taking { check: string }.

  lambda (definition + params):
    definition: (args: { names: string[] }): string[] { return args.names.map(n => n.toUpperCase()); }
    params:     { "names": ["a", "b"] }

SHAPE  (TypeScript)
  type ToolFunction =
    | { action: 'define'; definition: string; description?: string }
    | { action: 'lambda'; definition: string; params?: object }
    | { action: 'list' }
    | { action: 'types' }
    | { action: 'remove'; name: string };`;

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action:     { type: 'string', enum: ['define', 'lambda', 'list', 'types', 'remove'], description: 'define: persist a named function as a tool. lambda: run an anonymous function once. types: get TypeScript declarations of tool return types. list / remove: manage defined functions.' },
    definition:  { type: 'string', description: 'define/lambda: the function source (method-shorthand TypeScript, no arrow).' },
    description: { type: 'string', description: 'define only (optional): Describe the intent of the function from the context used to create it. Include a clause describing the use-cases for the function tool. Becomes the defined tool\'s description, and therefore it is important to make the description both specific in terms of intent and use-cases. Do not describe the mechanism or execution as this is already clear from the code.' },
    params:      { type: 'object', description: 'lambda only: the single argument object passed to the function.' },
    name:       { type: 'string', description: 'remove only: the defined function/tool name to delete.' },
  },
};

const errorEvent = (message: string): ToolEvent => ({ type: 'error', message });

function functionTool(machine: MatbotMachine, store: FunctionStore): Tool<ToolResultOf<'tool_function'>> {
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
              const { name, parameters } = await store.define(act.definition, act.description);
              const params = parameters.map(p => p.name).join(', ');
              yield { type: 'result', value: { message: `Defined tool "${name}"${params ? ` (${params})` : ''}. Call it directly to run.`, tool: name, parameters } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'lambda': {
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('lambda requires a "definition" (an anonymous function).'); return; }
            let fn: CompiledFn;
            try { fn = await buildAsyncFn(machine.TypeScriptStripper, act.definition, ['args']); }
            catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); return; }
            yield* runFunction(machine, ctx, fn, [act.params ?? {}]);
            return;
          }
          case 'list':
            yield { type: 'result', value: { functions: store.list() } };
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
            if (typeof act.name !== 'string' || act.name === '') { yield errorEvent('remove requires a "name".'); return; }
            const ok = await store.remove(act.name);
            yield { type: 'result', value: { message: ok ? `Removed "${act.name}".` : `No function named "${act.name}" was defined here.` } };
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
  let store: FunctionStore | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'Author and run TypeScript functions that compose registered tools (`tool_function`: define/lambda/list/remove).' },

    async setup(services) {
      store = new FunctionStore(services, services.settings());
      await store.reload();
      services.tools.register(functionTool(services, store));
    },

    async teardown() { store?.removeAll(); },
  };
}

export const plugin: MatbotPluginSpec = createFunctionToolsPlugin();
