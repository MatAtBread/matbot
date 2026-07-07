import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  JSONSchema, MatbotMachine, MatbotPluginSpec, PluginSettings,
  Tool, ToolContext, ToolEvent, ToolContract, ToolResultOf,
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

/** The type-check snippet for a parsed function: its body as an async fn, checked against the live tool
 *  types via {@link ToolTypeIndex.check}. A declared return type is Promise-wrapped and verified against the
 *  body; without one (a lambda may omit it) TS infers it, still checking the body and its `tool` calls. */
function checkSnippet(sig: ParsedSignature): string {
  if (sig.returnType === undefined) return `async function __fn(${sig.paramsText}) ${sig.body}`;
  const ret = /^Promise\s*</.test(sig.returnType) ? sig.returnType : `Promise<${sig.returnType}>`;
  return `async function __fn(${sig.paramsText}): ${ret} ${sig.body}`;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    tool_function:
      | ToolContract<{ message: string; tool: string; parameters: ParsedParam[] }, { action: 'define'; definition: string; description?: string; noTypeCheck?: boolean }>
      | ToolContract<unknown,                                                      { action: 'lambda'; definition: string; params?: object; noTypeCheck?: boolean }>
      | ToolContract<{ functions: FunctionRecord[] },                             { action: 'list'   }>
      | ToolContract<{ available: boolean; dts: string },                         { action: 'types'  }>
      | ToolContract<{ message: string },                                         { action: 'remove'; name: string }>;
  }
}

type ToolFunctionAction =
  | { action: 'define'; definition: string; description?: string; noTypeCheck?: boolean }
  | { action: 'lambda'; definition: string; params?: unknown; noTypeCheck?: boolean }
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

  async define(definition: string, description?: string, noTypeCheck = false): Promise<{ name: string; parameters: ParsedParam[] }> {
    const sig = parseSignature(definition);
    if (sig.name === undefined) throw new Error('define requires a NAMED function, e.g. `weather(city: string): string { … }`.');
    if (sig.name === TOOL_NAME) throw new Error(`"${TOOL_NAME}" is reserved.`);
    if (sig.returnType === undefined) throw new Error('define requires an explicit return type — it is verified against the body and becomes the tool\'s result contract, e.g. `weather(city: string): string { … }`. Use `: void` for a side-effect-only tool, or `: unknown` if the result is genuinely dynamic.');
    const clash = this.machine.tools.resolve(sig.name);
    if (clash !== null && !this.defined.has(sig.name)) {
      throw new Error(`A tool named "${sig.name}" already exists and wasn't defined here — choose another name.`);
    }
    // Type-check the body against the live tool types before registering — a strong signal the composition
    // is sound before it becomes a callable tool. Skipped when the ToolTypeIndex service is absent (e.g. the
    // browser — the function still compiles and runs), or when the caller opts out with noTypeCheck.
    const index = this.machine.ToolTypeIndex;
    if (index !== undefined && !noTypeCheck) {
      const diags = await index.check(checkSnippet(sig));
      if (diags.length > 0) throw new Error(`type error(s) — fix and re-define, or pass noTypeCheck to bypass:\n${diags.join('\n')}`);
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
    this.defined.delete(name);
    await this.persist();
    return true;
  }

  removeAll(): void {
    for (const name of this.defined.keys()) this.machine.tools.remove(name);
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
      // A defined function has no augmentation source; it carries its own contract. Same shape as a
      // ToolContracts arm — the params object paired with the declared return type — so tool-types splices
      // it into the dts registry block (bare `ToolContract` rewritten to an inline import) and derives the
      // wire text from it, exactly as it does from a source tool's arms.
      toolContract: `ToolContract<${sig.returnType ?? 'unknown'}, ${paramsTypeText(sig.params)}>`,
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
  }

  private async persist(): Promise<void> {
    await this.settings.set(STORE_KEY, { functions: [...this.defined.values()] });
  }
}

const DESCRIPTION = `Compose multiple tool calls — filter, count, reshape their results — without routing every intermediate result
back through the model. Compositions is expressed as TypeScript functions that orchestrate other tools in a single pass.

Inside a function, call any registered tool through the injected \`tool\` proxy:
\`const r = await tool.<tool_name>(params)\` runs that tool and resolves to its structured result (the same
value a direct call yields), inheriting this call's context. To run one call under a different context
(e.g. another model), use the \`toolInContext\` factory: \`await toolInContext({ provider: 'fast-model' }).<tool_name>(params)\`
— omitted fields are inherited. A tool name that doesn't exist is a compile error, so you can only call
tools that are actually registered. Every tool call MUST be awaited — the whole body runs as an async
function (so a recursive self-call must be awaited too). Return a JSON-serialisable value; that becomes
the result the model sees. Each tool call is echoed to stdout, so the run is observable.

Before composing, run \`{ action: 'types' }\` to fetch TypeScript declarations of what the available tools'
calls resolve to — write \`await tool.x(...)\` against those real return types instead of guessing shapes.

ACTIONS
  define — Persist a NAMED function and register it as a new tool of the same name. Parameters are
           derived from the signature and become the tool's inputs. You MUST declare an explicit return
           type — it is verified against the body and becomes the tool's result contract (use void for a
           side-effect-only tool). Pass an optional \`description\` to
           document the new tool (shown to the model). Survives restart. Re-defining the same name
           recompiles it. Never shadows a tool you didn't define here. Note: tools defined this way become
           visible on the *next turn*.
  lambda — Compile and run an ANONYMOUS one-argument function once, now, against \`params\`. Nothing is
           persisted or registered. Type-checked against the live tool types before running (like define),
           so a bad composition is caught before it runs; pass \`noTypeCheck: true\` to bypass.
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
    params:     { "names": ["a", "b"] }`;

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action:     { type: 'string', enum: ['define', 'lambda', 'list', 'types', 'remove'], description: 'define: persist a named function as a tool. lambda: run an anonymous function once. types: get TypeScript declarations of tool return types. list / remove: manage defined functions.' },
    definition:  { type: 'string', description: 'define/lambda: the function source (method-shorthand TypeScript, no arrow).' },
    description: { type: 'string', description: 'define only (optional): Describe the intent of the function from the context used to create it. Include a clause describing the use-cases for the function tool. Becomes the defined tool\'s description, and therefore it is important to make the description both specific in terms of intent and use-cases. Do not describe the mechanism or execution as this is already clear from the code.' },
    params:      { type: 'object', description: 'lambda only: the single argument object passed to the function.' },
    noTypeCheck: { type: 'boolean', description: 'define/lambda (optional, default false): skip the TypeScript type-check of the body against the live tool types. The check is a strong signal the composition is sound before it is registered/run — leave it on unless you must bypass a spurious error (e.g. composing a tool whose result type is `unknown`). No effect where no type-checker is available (e.g. the browser).' },
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
              const { name, parameters } = await store.define(act.definition, act.description, act.noTypeCheck === true);
              const params = parameters.map(p => p.name).join(', ');
              const note = act.noTypeCheck === true ? ' (type-check skipped)' : '';
              yield { type: 'result', value: { message: `Defined tool "${name}"${params ? ` (${params})` : ''}.${note} Call it directly to run.`, tool: name, parameters } };
            } catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); }
            return;
          }
          case 'lambda': {
            if (typeof act.definition !== 'string' || act.definition.trim() === '') { yield errorEvent('lambda requires a "definition" (an anonymous function).'); return; }
            let fn: CompiledFn;
            try { fn = await buildAsyncFn(machine.TypeScriptStripper, act.definition, ['args']); }
            catch (e) { yield errorEvent(e instanceof Error ? e.message : String(e)); return; }
            // Type-check the body against the live tool types before running (node only; opt out with
            // noTypeCheck). Syntax was already gated by buildAsyncFn above; an unparseable head just skips
            // the type-check (it already stripped and compiled).
            const index = machine.ToolTypeIndex;
            if (index !== undefined && act.noTypeCheck !== true) {
              let sig: ParsedSignature | undefined;
              try { sig = parseSignature(act.definition); } catch { /* head unparseable — skip */ }
              if (sig !== undefined) {
                const diags = await index.check(checkSnippet(sig));
                if (diags.length > 0) { yield errorEvent(`type error(s) — fix and re-run, or pass noTypeCheck to bypass:\n${diags.join('\n')}`); return; }
              }
            }
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
