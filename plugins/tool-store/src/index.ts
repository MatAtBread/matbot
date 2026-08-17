import { PLUGIN_API_VERSION, StoreQueryError } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, ToolContract, ToolResultOf, Store, StoreQuery,
} from '@matatbread/matbot-plugin-api';
import type { StoreDef, StoreRecord } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    store_action:
      | ToolContract<StoreDef,             { action: 'create'; namespace: string; description: string; shape: string }>
      | ToolContract<StoreDef,             { action: 'expose'; namespace: string; description: string; shape: string }>
      | ToolContract<StoreDef | null,      { action: 'get';    namespace: string }>
      | ToolContract<{ removed: boolean }, { action: 'remove'; namespace: string }>
      | ToolContract<{ stores: StoreDef[] }, { action: 'list' }>;
  }
}

const META_NAMESPACE = 'store_tools';

function now(): string { return new Date().toISOString(); }
function actionToolName(namespace: string): string { return `${namespace}_action`; }

// ── meta store: the plugin's own record of every store it manages ───────────────

// The StoreQuery keys, which belong under the `query` parameter and nowhere else. Kept as the
// rejection list for a caller that flattens them onto the action's own params.
const GRAMMAR_KEYS = ['where', 'sort', 'limit', 'cursor', 'immutable'];

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

// A namespace is LLM-supplied here, and this is the boundary it enters through — so it is checked
// here rather than defended against in every backend. It is not an opaque key: the filesystem backend
// makes it a directory name verbatim (document *ids* are percent-encoded, namespaces never were), so a
// `/` or `..` would write outside `.data` entirely, and SQLite makes it a table name. Restricting the
// character set at the one place untrusted names arrive is what lets each backend keep using it
// directly. The set admits every namespace matbot itself uses, punctuation included
// (`profile-registry`, `plugin-manifest`, `remembered_facts`).
const NAMESPACE_RE  = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAMESPACE_MAX = 64;

function namespaceError(namespace: string): string | undefined {
  if (namespace.length > NAMESPACE_MAX)
    return `"${namespace}" is too long — a namespace is at most ${NAMESPACE_MAX} characters.`;
  if (!NAMESPACE_RE.test(namespace))
    return `"${namespace}" is not a valid namespace. Use letters, digits, "_" and "-", starting with a letter or digit (e.g. "meeting_notes").`;
  return undefined;
}

/**
 * An existing namespace this one would collide with, compared case-INSENSITIVELY: a namespace becomes
 * a directory on the filesystem backend, and `Sessions` and `sessions` are one directory on macOS and
 * Windows. Asks the backend what it holds rather than probing this one name, which is the only way to
 * see a namespace some plugin owns — `sessions` itself is the case worth stopping, and the meta store
 * cannot know about it because no `store_action` created it.
 *
 * Backends that cannot enumerate simply contribute nothing, and a namespace holding no documents is
 * not reported, so this is one check among several rather than an oracle.
 */
async function collidingNamespace(services: MatbotMachine, namespace: string): Promise<string | undefined> {
  const existing = await services.StorageBackend?.namespaces?.() ?? [];
  const wanted   = namespace.toLowerCase();
  return existing.find(ns => ns.toLowerCase() === wanted);
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

// The store's declared `shape` as an INLINE structural type, so the synthesised `toolContract` references
// no external name (the shape type is defined only in this string, not in any scannable source). An
// `interface X { … }` → `{ … }`; a `type X = T` → `T`; anything else → `Record<string, unknown>`.
// Whitespace is collapsed to keep the emitted contract on one line. A shape that itself references a named
// type would leave that name dangling — the fix there is to export that type (so the dts can import it),
// not to inline it here.
function shapeType(shape: string): string {
  const iface = shape.match(/interface\s+\w+\s*(\{[\s\S]*\})\s*$/);
  if (iface) return iface[1]!.replace(/\s+/g, ' ').trim();
  const alias = shape.match(/type\s+\w+\s*=\s*([\s\S]+?);?\s*$/);
  if (alias) return alias[1]!.replace(/\s+/g, ' ').trim();
  return 'Record<string, unknown>';
}

// A tool over one managed store whose verbs are the Store<T> interface (get/set/cas/delete/query),
// with set doubling as upsert. Loose schema (action + the union of every action's optional fields);
// the executor enforces per-action requirements, matching the multi-action convention in CLAUDE.md.
function makeStoreTool(pluginName: string | undefined, def: StoreDef, store: Store<StoreRecord>): Tool {
  const typeGuess = def.shape.match(/(interface|type\s*=)\s+(\w+)/)?.[2] ?? 'Record<string, unknown>';  // the shape's NAME, for prose
  const doc       = shapeType(def.shape);                                                               // the shape as an inline type, for the toolContract
  return {
    name: actionToolName(def.namespace),
    ...(pluginName !== undefined ? { pluginName } : {}),
    description:
      `Access the "${def.namespace}" store — ${def.description}\n\n` +
      'Documents have this shape:\n' +
      '```ts\n' + def.shape + '\n```\n\n' +
      'Actions map onto the matbot `Store<' + typeGuess + '>` interface (get/set/cas/delete/query), with ' +
      '`set` doubling as upsert (omit `id` to create) and `query` matching all when omitted.\n\n' +
      'The `query` action takes the entire grammar in ONE `query` parameter. Every key below nests ' +
      'inside it and never sits beside `action`:\n' +
      '```json\n' +
      '{ "action": "query", "query": { "where": …, "sort": …, "limit": 20 } }\n' +
      '```\n' +
      '```ts\n' +
      "type FieldPath = string | string[];  // a bare string is ONE key (never split on '.'); use an array for a nested path\n" +
      'type StoreQuery = {\n' +
      '  where?:  Filter;\n' +
      "  sort?:   { field: FieldPath; dir: 'asc' | 'desc' }[];\n" +
      '  limit?:  number;  // 0 = count only: no items, just `total`\n' +
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
      '`query` returns `{ items, cursor?, total? }`. To COUNT matches without fetching them, use a ' +
      'limit of 0 — the filter still runs and `total` is the answer, but no document is returned: ' +
      '`{ "action": "query", "query": { "limit": 0 } }`.\n\n' +
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
    // Source-less: the tool's name and its shape are per-store, built at runtime, so it can't carry a static
    // `ToolContracts` augmentation. It declares its contract as a `toolContract` string — identical in shape
    // to an augmentation arm (result, params) — which the tool-types index splices into the dts and flattens
    // for the wire. The result/data shape is inlined structurally (`doc`) so it references no name the dts
    // lacks; `StoreQuery` stays a name — it's a plugin-api export, so the dts imports it.
    toolContract:
      "ToolContract<" +
        doc + " | null | { ok: true; doc: " + doc + " } | { ok: false; current: " + doc + " | null }" +
        " | { deleted: boolean } | { items: " + doc + "[]; total?: number; cursor?: string }" +
      ", " +
        "{ action: 'get'; id: string } | { action: 'set'; id?: string; data: " + doc + " }" +
        " | { action: 'cas'; id: string; expected: string; data: " + doc + " }" +
        " | { action: 'delete'; id: string; expected?: string } | { action: 'query'; query?: StoreQuery }" +
      ">",
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
            // A grammar key passed alongside `action` instead of inside `query`. `input.query` would
            // be undefined, the query would degrade to match-everything, and the caller would get a
            // plausible answer with no signal it was malformed — the exact silent miss `validateQuery`
            // rejects unknown top-level keys to prevent, one level up, where `inputSchema` is loose by
            // design. `limit: 0` is the case that bites hardest: the count form comes back as every
            // document in the store plus a total, which reads like it worked.
            const misplaced = GRAMMAR_KEYS.filter(k => k in (input as unknown as Record<string, unknown>));
            if (misplaced.length > 0) {
              const list = misplaced.map(k => `"${k}"`).join(', ');
              yield { type: 'error', message: `${list} ${misplaced.length === 1 ? 'belongs' : 'belong'} inside "query", not beside "action" — call { "action": "query", "query": { ${misplaced.map(k => `"${k}": …`).join(', ')} } }. See the \`query\` grammar in this tool's description.` };
              return;
            }
            let res;
            try {
              res = await store.query(input.query ?? {});
            } catch (e) {
              if (e instanceof StoreQueryError) {
                yield { type: 'error', message: `Invalid query at ${e.pointer}: ${e.message}. See the \`query\` grammar in this tool's description for the exact StoreQuery shape.` };
                return;
              }
              throw e;
            }
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
      '`create` mints a new store + tool and fails if one already exists; `expose` mints a tool over an ' +
      'EXISTING store (including one created elsewhere) and fails if absent; `remove` drops the ' +
      "definition and its tool but leaves the store's data intact; `get` reads one definition; `list` " +
      'returns them all.',
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
            const invalid = namespaceError(input.namespace);
            if (invalid !== undefined) { yield { type: 'error', message: invalid }; return; }
            if (input.namespace === META_NAMESPACE) { yield { type: 'error', message: `"${META_NAMESPACE}" is reserved.` }; return; }
            if (await meta.get(input.namespace) || await storeHasData(services, input.namespace)) {
              yield { type: 'error', message: `Store "${input.namespace}" already exists. Use action "expose".` };
              return;
            }
            // A namespace already in the backend that no store_action created — a plugin's own store
            // (`sessions`), or one differing only by case, which is the SAME directory on a
            // case-insensitive filesystem. Creating over either would quietly share its storage.
            const clash = await collidingNamespace(services, input.namespace);
            if (clash !== undefined) {
              yield { type: 'error', message: clash === input.namespace
                ? `"${input.namespace}" already exists in storage (it belongs to a plugin, not to this tool). Use action "expose" to manage it, or pick another name.`
                : `"${input.namespace}" collides with the existing namespace "${clash}" — namespaces differing only by case share one store on macOS and Windows. Pick a distinct name.` };
              return;
            }
            yield await define(input);
            return;
          }

          case 'expose': {
            if (!input.namespace) { yield { type: 'error', message: 'expose requires "namespace".' }; return; }
            const badExpose = namespaceError(input.namespace);
            if (badExpose !== undefined) { yield { type: 'error', message: badExpose }; return; }
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
