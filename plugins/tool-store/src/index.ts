import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, ToolResult, ToolResultOf, Store, StoreQuery,
} from '@matatbread/matbot-plugin-api';
import type { StoreDef, StoreRecord } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    store_action:
      | ToolResult<StoreDef,             { action: 'create' }>
      | ToolResult<StoreDef,             { action: 'expose' }>
      | ToolResult<StoreDef | null,      { action: 'get'    }>
      | ToolResult<{ removed: boolean }, { action: 'remove' }>
      | ToolResult<{ stores: StoreDef[] }, { action: 'list' }>;
  }
}

const META_NAMESPACE = 'store_tools';

function now(): string { return new Date().toISOString(); }
function actionToolName(namespace: string): string { return `${namespace}_action`; }

// ── meta store: the plugin's own record of every store it manages ───────────────

async function listDefs(meta: Store<StoreDef>): Promise<StoreDef[]> {
  const res = await meta.query({});
  return res.items;
}

function registerStoreTool(services: MatbotMachine, def: StoreDef): void {
  services.tools.remove(actionToolName(def.namespace));
  services.tools.register(makeStoreTool(services.self?.name, def, services.createStore<StoreRecord>(def.namespace)));
}

/**
 * Persist a store definition and (re)register its generated `<namespace>_action` tool. This is the
 * single mechanism behind `store_action`'s create/expose verbs, exported so other plugins can seed a
 * built-in store at setup() without going through the LLM-facing tool (e.g. cognition's
 * `remembered_facts`). Idempotent: re-defining an existing namespace preserves its `createdAt` and
 * simply re-registers the tool, matching the restart behaviour. Returns the persisted def.
 */
export async function defineStore(
  services: MatbotMachine,
  spec: { namespace: string; description: string; shape: string },
): Promise<StoreDef> {
  const meta = services.createStore<StoreDef>(META_NAMESPACE);
  const existing = await meta.get(spec.namespace);
  const def: StoreDef = {
    id:          spec.namespace,
    version:     crypto.randomUUID(),
    namespace:   spec.namespace,
    description: spec.description,
    shape:       spec.shape,
    createdAt:   existing?.createdAt ?? now(),
    updatedAt:   now(),
  };
  await meta.set(def.id, def);
  registerStoreTool(services, def);
  return def;
}

// A namespace "exists" if we already govern it, or it already holds documents (a store created by
// other means). createStore is lazy, so an untouched namespace queries empty.
async function storeHasData(services: MatbotMachine, namespace: string): Promise<boolean> {
  const store = services.createStore<StoreRecord>(namespace);
  const res = await store.query({ limit: 1 });
  return res.items.length > 0;
}

// ── generated per-store tool: actions map directly onto Store<T> ─────────────────

interface ActionInput {
  action:    string;
  id?:       string;
  data?:     Record<string, unknown>;
  expected?: string;
  query?:    StoreQuery;
}

// A tool over one managed store whose verbs are the Store<T> interface (get/set/cas/delete/query),
// with set doubling as upsert. Loose schema (action + the union of every action's optional fields);
// the executor enforces per-action requirements, matching the multi-action convention in CLAUDE.md.
function makeStoreTool(pluginName: string | undefined, def: StoreDef, store: Store<StoreRecord>): Tool {
  const typeGuess = def.shape.match(/(interface|type\s*=)\s+(\w+)/)?.[2] ?? 'Record<string, unknown>';
  return {
    name: actionToolName(def.namespace),
    ...(pluginName !== undefined ? { pluginName } : {}),
    description:
      `Access the "${def.namespace}" store — ${def.description}\n\n` +
      'Documents have this shape:\n' +
      '```ts\n' + def.shape + '\n```\n\n' +
      'Actions map onto the matbot `Store<'+ typeGuess + '>` interface:\n' +
      '```ts\n' +
      'type Action =\n' +
      "  | { action: 'get';    id: string }\n" +
      "  | { action: 'set';    id?: string; data: " + typeGuess + " }                  // upsert; id omitted ⇒ created\n" +
      "  | { action: 'cas';    id: string; expected: string; data: " + typeGuess + " } // compare-and-swap on version\n" +
      "  | { action: 'delete'; id: string; expected?: string }\n" +
      "  | { action: 'query';  query?: StoreQuery };  // omit query ⇒ match all\n" +
      '```\n\n' +
      'The `query` grammar:\n' +
      '```ts\n' +
      "type FieldPath = string | string[];  // a bare string is ONE key (never split on '.'); use an array for a nested path\n" +
      'type StoreQuery = {\n' +
      '  where?:  Filter;\n' +
      "  sort?:   { field: FieldPath; dir: 'asc' | 'desc' }[];\n" +
      '  limit?:  number;\n' +
      '  cursor?: string;  // opaque & self-contained — to page, send back ONLY a previous result’s `cursor` (it already carries where/sort/limit/position); anything passed alongside it is ignored\n' +
      '};\n' +
      'type Filter =\n' +
      "  | { op: 'eq' | 'neq';                field: FieldPath; value: string | number | boolean }\n" +
      "  | { op: 'lt' | 'lte' | 'gt' | 'gte'; field: FieldPath; value: string | number }\n" +
      "  | { op: 'in' | 'nin';                field: FieldPath; value: (string | number | boolean)[] }\n" +
      "  | { op: 'exists';                    field: FieldPath; value: boolean }                    // true = present & non-null; false = absent or null\n" +
      "  | { op: 'stringContains';            field: FieldPath; value: string }                     // substring of a string field\n" +
      "  | { op: 'arrayContains';             field: FieldPath; value: string | number | boolean }  // element of an array field\n" +
      "  | { op: 'and' | 'or';                clauses: Filter[] }\n" +
      "  | { op: 'not';                       clause: Filter };\n" +
      '```\n' +
      'Comparisons are type-strict (5 ≠ "5"); null/absent match nothing except `{op:\'exists\',value:false}` — never compare to null. ' +
      '`query` returns `{ items, cursor?, total? }`.\n\n' +
      '`version` is managed for you (a fresh one is minted on every set/cas) — never set it yourself; ' +
      'pass the value you last read as `expected` to cas/delete for safe concurrent updates.',
    inputSchema: {
      type: 'object',
      properties: {
        action:   { type: 'string', enum: ['get', 'set', 'cas', 'delete', 'query'] },
        id:       { type: 'string' },
        data:     { type: 'object' },
        expected: { type: 'string' },
        query:    { type: 'object' },
      },
      required: ['action'],
    },
    executor: {
      async *execute(rawInput: unknown): AsyncIterable<ToolEvent> {
        const input = (rawInput ?? {}) as ActionInput;
        switch (input.action) {
          case 'get': {
            if (!input.id) { yield { type: 'error', message: 'get requires "id".' }; return; }
            yield { type: 'result', value: await store.get(input.id) };
            return;
          }
          case 'set': {
            if (!input.data) { yield { type: 'error', message: 'set requires "data".' }; return; }
            const id  = input.id ?? crypto.randomUUID();
            const rec: StoreRecord = { ...input.data, id, version: crypto.randomUUID() };
            await store.set(id, rec);
            yield { type: 'result', value: rec };
            return;
          }
          case 'cas': {
            if (!input.id)       { yield { type: 'error', message: 'cas requires "id".' }; return; }
            if (!input.expected) { yield { type: 'error', message: 'cas requires "expected" (the version you last read).' }; return; }
            if (!input.data)     { yield { type: 'error', message: 'cas requires "data".' }; return; }
            const next: StoreRecord = { ...input.data, id: input.id, version: crypto.randomUUID() };
            const res = await store.cas(input.id, input.expected, next);
            yield { type: 'result', value: res };
            return;
          }
          case 'delete': {
            if (!input.id) { yield { type: 'error', message: 'delete requires "id".' }; return; }
            const ok = await store.delete(input.id, input.expected);
            yield { type: 'result', value: { deleted: ok } };
            return;
          }
          case 'query': {
            const res = await store.query(input.query ?? {});
            yield { type: 'result', value: { items: res.items, ...(res.total !== undefined ? { total: res.total } : {}), ...(res.cursor !== undefined ? { cursor: res.cursor } : {}) } };
            return;
          }
          default:
            yield { type: 'error', message: `Unknown action "${String(input.action)}". Expected: get, set, cas, delete, query.` };
        }
      },
    },
  };
}

// ── store_action: define stores and expose tools over them ──────────────────────

interface StoreActionInput {
  action:       string;
  namespace?:   string;
  description?: string;
  shape?:       string;
}

function makeStoreActionTool(services: MatbotMachine, meta: Store<StoreDef>): Tool<ToolResultOf<'store_action'>> {
  const pluginName = services.self?.name;

  // Shared by create and expose: persist the def and (re)register its tool. Caller has already
  // settled the create-vs-expose existence check.
  async function define(input: StoreActionInput): Promise<ToolEvent<ToolResultOf<'store_action'>>> {
    if (!input.namespace)   return { type: 'error', message: 'requires "namespace".' };
    if (!input.description) return { type: 'error', message: 'requires "description" (what the store holds).' };
    if (!input.shape)       return { type: 'error', message: 'requires "shape" (a flattened TypeScript type/interface).' };
    const def = await defineStore(services, { namespace: input.namespace, description: input.description, shape: input.shape });
    return { type: 'result', value: def };
  }

  return {
    name: 'store_action',
    ...(pluginName !== undefined ? { pluginName } : {}),
    description:
      'Define named persistent stores and expose a generated tool over each.\n\n' +
      'A "store" is a typed key-value collection (documents keyed by id — the matbot `Store` ' +
      'interface). Exposing a store mints a `<namespace>_action` tool the model can use to ' +
      'get/set/cas/delete/query its documents. This tool keeps its own record of every store it ' +
      'manages (the document shape and description), so those tools are re-registered on restart.\n\n' +
      'Both `create` and `expose` require a plain-English `description` of what the store holds and ' +
      'a `shape` — the document type written as a flattened TypeScript type/interface — which is ' +
      'shown to the model in the generated tool.\n\n' +
      'Actions (TypeScript):\n' +
      '```ts\n' +
      'type StoreAction =\n' +
      "  | { action: 'create'; namespace: string; description: string; shape: string }  // new store + tool; fails if it already exists\n" +
      "  | { action: 'expose'; namespace: string; description: string; shape: string }  // tool over an EXISTING store (incl. ones created elsewhere); fails if absent\n" +
      "  | { action: 'get';    namespace: string }\n" +
      "  | { action: 'remove'; namespace: string }   // drops the definition and its tool (store data is left intact)\n" +
      "  | { action: 'list' };\n" +
      '```',
    inputSchema: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['create', 'expose', 'get', 'remove', 'list'] },
        namespace:   { type: 'string' },
        description: { type: 'string' },
        shape:       { type: 'string' },
      },
      required: ['action'],
    },
    executor: {
      async *execute(rawInput: unknown) {
        const input = (rawInput ?? {}) as StoreActionInput;

        switch (input.action) {
          case 'create': {
            if (!input.namespace) { yield { type: 'error', message: 'create requires "namespace".' }; return; }
            if (input.namespace === META_NAMESPACE) { yield { type: 'error', message: `"${META_NAMESPACE}" is reserved.` }; return; }
            if (await meta.get(input.namespace) || await storeHasData(services, input.namespace)) {
              yield { type: 'error', message: `Store "${input.namespace}" already exists. Use action "expose".` };
              return;
            }
            yield await define(input);
            return;
          }

          case 'expose': {
            if (!input.namespace) { yield { type: 'error', message: 'expose requires "namespace".' }; return; }
            if (input.namespace === META_NAMESPACE) { yield { type: 'error', message: `"${META_NAMESPACE}" is reserved.` }; return; }
            if (!(await meta.get(input.namespace)) && !(await storeHasData(services, input.namespace))) {
              yield { type: 'error', message: `No store "${input.namespace}" found. Use action "create" to make a new one.` };
              return;
            }
            yield await define(input);
            return;
          }

          case 'get': {
            if (!input.namespace) { yield { type: 'error', message: 'get requires "namespace".' }; return; }
            yield { type: 'result', value: await meta.get(input.namespace) };
            return;
          }

          case 'remove': {
            if (!input.namespace) { yield { type: 'error', message: 'remove requires "namespace".' }; return; }
            const ok = await meta.delete(input.namespace);
            services.tools.remove(actionToolName(input.namespace));
            yield { type: 'result', value: { removed: ok } };
            return;
          }

          case 'list': {
            yield { type: 'result', value: { stores: await listDefs(meta) } };
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(input.action)}". Expected: create, expose, get, remove, list.` };
        }
      },
    },
  };
}

// ── plugin ──────────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Define persistent stores and generated CRUD tools over them via store_action.',
  },

  async setup(services: MatbotMachine) {
    const meta = services.createStore<StoreDef>(META_NAMESPACE);

    services.tools.register(makeStoreActionTool(services, meta));

    // Re-register a tool for every managed store, so definitions survive a restart.
    for (const def of await listDefs(meta)) {
      registerStoreTool(services, def);
    }
  },
};
