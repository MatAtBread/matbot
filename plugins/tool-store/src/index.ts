import { PLUGIN_API_VERSION, StoreQueryError } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, ToolContract, ToolResultOf, Store, StoreQuery,
} from '@matatbread/matbot-plugin-api';
import type { StoreDef, StoreRecord } from './types.js';
import { parseShape, shapeName, shapeType } from './shape.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    store_action:
      | ToolContract<StoreDef,             { action: 'create'; name: string; description: string; shape: string }>
      | ToolContract<StoreDef | null,      { action: 'get';    name: string }>
      | ToolContract<{ removed: boolean }, { action: 'remove'; name: string }>
      | ToolContract<{ stores: StoreDef[] }, { action: 'list' }>;
  }
}

const META_NAMESPACE = 'store_tools';

// Where a store the model creates keeps its documents. A namespace of its own is what keeps a model-named
// store out of every plugin's: unprefixed, `create email_accounts` before matbot-email is installed
// would hand that plugin's store to a model-writable tool, and no check made at create time can see a
// plugin that is not loaded yet. Defs from before 0.5.0 keep the unprefixed namespace they were created
// with (`id === namespace`), so nothing is migrated.
const OWN_PREFIX = 'store-';

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
  // A def persisted before the shape was checked — or seeded programmatically — still registers, since
  // refusing here would take an existing store's tool away at boot. It says so once instead.
  const { fault } = parseShape(def.shape);
  if (fault !== undefined) {
    console.warn(`[tool-store] Store "${def.id}" has an unreadable shape, so its documents are typed \`Record<string, unknown>\` and nothing about them is checked: ${fault}\n`);
  }
  let store: Store<StoreRecord>;
  try { store = services.createStore<StoreRecord>(def.namespace); }
  catch (e) {
    // A def exposing a namespace the host will not open (`settings`, which `expose` once reached) is
    // skipped rather than failing the plugin, which would take every other store's tool with it.
    console.warn(`[tool-store] Store "${def.id}" is not registered (remove it with \`store_action remove\`): ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Only a tool of this plugin's is replaced (the host refuses to remove another's), and a name another
  // plugin holds goes through the host's collision decision rather than round it.
  services.tools.remove(actionToolName(def.id));
  services.tools.register(makeStoreTool(services.self?.name, def, store));
}

async function saveDef(
  services: MatbotMachine,
  spec: { id: string; namespace: string; description: string; shape: string; owner?: string },
): Promise<StoreDef> {
  const meta = services.createStore<StoreDef>(META_NAMESPACE);
  const existing = await meta.get(spec.id);
  const def: StoreDef = {
    ...spec,
    version:     crypto.randomUUID(),
    createdAt:   existing?.createdAt ?? now(),
    updatedAt:   now(),
  };
  await meta.set(def.id, def);
  registerStoreTool(services, def);
  return def;
}

/**
 * Expose a plugin's OWN store through a generated `<namespace>_action` tool — the owner's opt-in, for
 * a plugin whose store a model should read and write directly (cognition's `remembered_facts`). Called
 * from that plugin's setup(), never on a model's behalf: which namespaces a plugin holds is that
 * plugin's knowledge, so only it can say one is safe to hand over. Idempotent: re-defining preserves
 * `createdAt` and re-registers the tool, matching the restart behaviour. An owner's def replaces a
 * model's of the same name, whose documents stay in its own `store-` namespace.
 */
export async function defineStore(
  services: MatbotMachine,
  spec: { namespace: string; description: string; shape: string },
): Promise<StoreDef> {
  const owner = services.self?.name;
  return saveDef(services, { id: spec.namespace, ...spec, ...(owner !== undefined ? { owner } : {}) });
}

// A store's name is LLM-supplied, and this is the boundary it enters through — so it is checked here
// rather than defended against in every backend. It becomes part of a namespace, which is not an opaque
// key: the filesystem backend makes it a directory name verbatim (document *ids* are percent-encoded,
// namespaces never were), so a `/` or `..` would write outside `.data` entirely, and SQLite makes it a
// table name. It also becomes the tool name `<name>_action`, which providers cap at 64 characters.
const NAME_RE  = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME_MAX = 64 - actionToolName('').length;

/**
 * The shape is LLM-authored TypeScript and this is where it arrives, so it is read here rather than
 * left to degrade later. A shape that does not parse yields `Record<string, unknown>`: a document of
 * anything, which validates anything — a store that appears to work and checks nothing, whose only
 * symptom is types that are quietly useless. Refused at the boundary, where the author is present and
 * the message can name the fix; an already-persisted def only warns (see `registerStoreTool`).
 */
function shapeFault(shape: unknown): string | undefined {
  if (typeof shape !== 'string' || shape.trim() === '') return 'a "shape" is required — the document type as TypeScript, e.g. `interface Note { title: string; body?: string }`.';
  const { fault } = parseShape(shape);
  return fault === undefined ? undefined
    : `The "shape" could not be read as a document type: ${fault}`;
}

function nameError(name: string): string | undefined {
  if (name.length > NAME_MAX)
    return `"${name}" is too long — a store name is at most ${NAME_MAX} characters.`;
  if (!NAME_RE.test(name))
    return `"${name}" is not a valid store name. Use letters, digits, "_" and "-", starting with a letter or digit (e.g. "meeting_notes").`;
  return undefined;
}

/**
 * A namespace differing from this one only by case: a namespace becomes a directory on the filesystem
 * backend, and `store-Notes` and `store-notes` are one directory on macOS and Windows. The defs give the
 * ones this plugin governs; the backend's listing adds a removed store's, whose documents stay behind.
 * A backend that cannot enumerate contributes nothing, so this is one check rather than an oracle.
 */
async function caseVariant(services: MatbotMachine, meta: Store<StoreDef>, namespace: string): Promise<string | undefined> {
  const held = [
    ...(await listDefs(meta)).map(d => d.namespace),
    ...(await services.StorageBackend?.namespaces?.() ?? []),
  ];
  const wanted = namespace.toLowerCase();
  return held.find(ns => ns !== namespace && ns.toLowerCase() === wanted);
}

/**
 * The key a write addresses, or why it cannot be answered.
 *
 * ONE invariant: an `id` inside `data` must not contradict the key. The key is always the top-level
 * `id` (minted when absent), and `{ ...data, id }` writes it into the body, so the two can never
 * disagree in storage — which is exactly why a disagreement in the CALL has to be refused rather than
 * resolved. Both ways of resolving it are silent and lossy: discarding `data.id` writes the caller's
 * edit to a document they did not name, and honouring it writes to one they did not name either.
 *
 * `{ ...doc }` carries the id it was read with, so both refusals are reachable from the natural
 * round-trip, and both name the two repairs: pass the id as the key, or blank it in `data`. An absent
 * or `undefined` `data.id` states no opinion — which is what makes `{ ...doc, id: undefined }` the way
 * to say "copy this".
 */
export function writeDestination(
  inputId: string | undefined, data: Record<string, unknown>,
): { id: string } | { error: string } {
  const carried = typeof data['id'] === 'string' ? data['id'] : undefined;
  const id      = inputId ?? crypto.randomUUID();
  if (carried === undefined || carried === id) return { id };
  const q = (v: string): string => JSON.stringify(v);
  return { error: inputId === undefined
    ? `"data" carries id ${q(carried)} but no top-level "id" was given, so this would create a NEW document under a minted id and leave ${q(carried)} untouched. Pass "id": ${q(carried)} to write that document, or set "id" to undefined in "data" to copy it into a new one.`
    : `"data" carries id ${q(carried)} but this write addresses ${q(id)} — they must agree. Pass "id": ${q(carried)} to write that document, or set "id" to undefined in "data" to write to ${q(id)}.` };
}

// ── generated per-store tool: actions map directly onto Store<T> ─────────────────

interface ActionInput {
  action:    string;
  id?:       string;
  data?:     Record<string, unknown>;
  expected?: string;
  query?:    StoreQuery;
}

/**
 * The generated tool's `toolContract` — ONE ARM PER ACTION, not one arm carrying two unions.
 *
 * `ToolProxy` turns a multi-arm entry into an overload set, which is what makes
 * `await tool.x_action({ action: 'query' })` narrow to the query result. A single arm is a single
 * signature, so the declared result was the union across all five actions and no action's own fields
 * were reachable without a guard — and since a cast is barred by the check gate, a caller could not
 * write correct code against a store tool at all. The workaround was to flatten the document shape into
 * one record with every field optional, losing the modelling the contract exists to carry.
 *
 * Keep the arms `|`-joined and literal: build-dts reads them as a union type node and the wire
 * projection splits on a top-level `|`, so neither tolerates an alias standing in for the union.
 *
 * `id` and `version` are the `Store` contract's, not the author's, so a declared shape usually omits
 * them — but a read hands both back. Hence two forms of the document type: `stored` for results (both
 * present, so `version` can be read to pass as `expected`) and `writable` for `data` (both optional, so
 * a document just read goes straight back in). Accepted and IGNORED rather than honoured — the executor
 * mints a fresh `version` on every write and takes `id` from the parameter.
 *
 * Each is wrapped WHOLE, not just around the shape: `&` binds tighter than `|` (a union shape) and `[]`
 * binds tighter than `&`, so an unwrapped `stored[]` reads as `doc & ({ id; version }[])` — an
 * intersection with an array whose element type has lost the document. It typechecks, and is wrong.
 */
export function storeToolContract(shape: string): string {
  const doc      = shapeType(shape);
  const stored   = `((${doc}) & { id: string; version: string })`;
  const writable = `((${doc}) & { id?: string; version?: string })`;
  return [
    `ToolContract<${stored} | null, { action: 'get'; id: string }>`,
    `ToolContract<${stored}, { action: 'set'; id?: string; data: ${writable} }>`,
    `ToolContract<{ ok: true; doc: ${stored} } | { ok: false; current: ${stored} | null }`
      + `, { action: 'cas'; id: string; expected: string; data: ${writable} }>`,
    "ToolContract<{ deleted: boolean }, { action: 'delete'; id: string; expected?: string }>",
    `ToolContract<{ items: ${stored}[]; total?: number; cursor?: string }`
      + `, { action: 'query'; query?: StoreQuery }>`,
  ].join(' | ');
}

// A tool over one managed store whose verbs are the Store<T> interface (get/set/cas/delete/query),
// with set creating or replacing. Loose schema (action + the union of every action's optional fields);
// the executor enforces per-action requirements, matching the multi-action convention in CLAUDE.md.
function makeStoreTool(pluginName: string | undefined, def: StoreDef, store: Store<StoreRecord>): Tool {
  const typeGuess = shapeName(def.shape) ?? 'Record<string, unknown>';   // the shape's NAME, for prose
  return {
    name: actionToolName(def.id),
    ...(pluginName !== undefined ? { pluginName } : {}),
    description:
      `Access the "${def.id}" store — ${def.description}\n\n` +
      'Documents have this shape:\n' +
      '```ts\n' + def.shape + '\n```\n\n' +
      'Actions map onto the matbot `Store<' + typeGuess + '>` interface (get/set/cas/delete/query); ' +
      '`query` matches all when omitted.\n\n' +
      '`set` CREATES OR REPLACES — it is never a merge. The document you send becomes the whole ' +
      'document, and every field you omit is deleted. The TOP-LEVEL `id` decides which document is ' +
      'written: give one to create or replace at that id, and omit it to create a new one under a ' +
      'minted id. To change one field of an existing document, `get` it first and send the whole thing ' +
      'back with that field changed.\n\n' +
      'An `id` inside `data` must AGREE with that key — a document you read back carries its own `id`, ' +
      'so sending it straight to `set` states which document it is. A disagreement is refused rather ' +
      'than guessed at, because both ways of resolving it are silent and lossy. To REPLACE the document ' +
      'you read, pass its `id` as the top-level `id`. To COPY it — to a new document, or to another id ' +
      '— blank the one it carries:\n' +
      '```ts\n' +
      "await tool." + actionToolName(def.id) + "({ action: 'set', data: { ...doc, id: undefined } });          // copy to a new id\n" +
      "await tool." + actionToolName(def.id) + "({ action: 'set', id: 'other', data: { ...doc, id: undefined } });  // copy to \"other\"\n" +
      '```\n\n' +
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
      '`version` is managed for you: a fresh one is minted on every set/cas, so a `version` (or `id`) ' +
      'in `data` is accepted and IGNORED — send a document you just read straight back without ' +
      'stripping anything. Pass the value you last read as `expected` to cas/delete for safe ' +
      'concurrent updates:\n' +
      '```ts\n' +
      "const doc = await tool." + actionToolName(def.id) + "({ action: 'get', id });\n" +
      "if (doc !== null) await tool." + actionToolName(def.id) + "({ action: 'set', id, data: { ...doc, someField: next } });\n" +
      '```\n',
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
    toolContract: storeToolContract(def.shape),
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
            const dest = writeDestination(input.id, input.data);
            if ('error' in dest) { yield { type: 'error', message: `set: ${dest.error}` }; return; }
            const id = dest.id;
            const rec: StoreRecord = { ...input.data, id, version: crypto.randomUUID() };
            await store.set(id, rec);
            yield { type: 'result', value: rec };
            return;
          }
          case 'cas': {
            if (!input.id)       { yield { type: 'error', message: 'cas requires "id".' }; return; }
            if (!input.expected) { yield { type: 'error', message: 'cas requires "expected" (the version you last read).' }; return; }
            if (!input.data)     { yield { type: 'error', message: 'cas requires "data".' }; return; }
            // Same invariant as `set` — `cas` takes the identical `data`, and leaving it to discard a
            // contradicting `data.id` silently would restore the asymmetry that removal just closed.
            const casDest = writeDestination(input.id, input.data);
            if ('error' in casDest) { yield { type: 'error', message: `cas: ${casDest.error}` }; return; }
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
  name?:        string;
  description?: string;
  shape?:       string;
}

function makeStoreActionTool(services: MatbotMachine, meta: Store<StoreDef>): Tool<ToolResultOf<'store_action'>> {
  const pluginName = services.self?.name;

  return {
    name: 'store_action',
    ...(pluginName !== undefined ? { pluginName } : {}),
    description:
      'Define named persistent stores and a generated tool over each.\n\n' +
      'A "store" is a typed key-value collection (documents keyed by id — the matbot `Store` ' +
      'interface). Creating one mints a `<name>_action` tool the model can use to ' +
      'get/set/cas/delete/query its documents. This tool keeps its own record of every store it ' +
      'manages (the document shape and description), so those tools are re-registered on restart.\n\n' +
      '`create` requires a plain-English `description` of what the store holds and ' +
      'a `shape` — the document type written as a flattened TypeScript type/interface — which is ' +
      'shown to the model in the generated tool.\n\n' +
      'ONE store may hold SEVERAL KINDS of document: write the shape as a discriminated union and each ' +
      'kind keeps its own fields, rather than flattening them into one record with everything optional.\n' +
      '```ts\n' +
      "type PresenceDoc =\n" +
      "  | { kind: 'site';  endpoint: string; windowHours: number }\n" +
      "  | { kind: 'state'; where: string };\n" +
      '```\n' +
      'A read narrows on the discriminant (`if (doc.kind === \'site\') doc.endpoint`), and a write of one ' +
      'arm mixed with another’s fields is rejected against the arm you meant. The shape must be one ' +
      'declaration and inline its members: `extends` is not resolved and a type declared elsewhere ' +
      'cannot be referenced by name.\n\n' +
      '`create` makes a store of this tool\'s own — it cannot open a store some plugin keeps, and fails ' +
      'if the name is already defined or its tool name is taken. `remove` drops the definition and its ' +
      "tool but leaves the store's documents intact; creating the same name again re-attaches them. " +
      '`get` reads one definition; `list` returns them all.',
    inputSchema: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['create', 'get', 'remove', 'list'] },
        name:        { type: 'string' },
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
            const { name } = input;
            if (!name) { yield { type: 'error', message: 'create requires "name".' }; return; }
            const invalid = nameError(name);
            if (invalid !== undefined) { yield { type: 'error', message: invalid }; return; }
            if (!input.description) { yield { type: 'error', message: 'create requires "description" (what the store holds).' }; return; }
            const badShape = shapeFault(input.shape);
            if (badShape !== undefined) { yield { type: 'error', message: badShape }; return; }
            if (await meta.get(name)) { yield { type: 'error', message: `Store "${name}" already exists.` }; return; }
            const toolName = actionToolName(name);
            const holder = services.tools.resolve(toolName);
            if (holder !== null) {
              yield { type: 'error', message: `"${name}" would generate the tool "${toolName}", which ${holder.pluginName === undefined ? 'the host' : `"${holder.pluginName}"`} already provides. Pick another name.` };
              return;
            }
            const namespace = OWN_PREFIX + name;
            const clash = await caseVariant(services, meta, namespace);
            if (clash !== undefined) {
              yield { type: 'error', message: `"${name}" collides with the existing namespace "${clash}" — names differing only by case share one store on macOS and Windows. Pick a distinct name.` };
              return;
            }
            yield { type: 'result', value: await saveDef(services, { id: name, namespace, description: input.description, shape: input.shape! }) };
            return;
          }

          case 'get': {
            if (!input.name) { yield { type: 'error', message: 'get requires "name".' }; return; }
            yield { type: 'result', value: await meta.get(input.name) };
            return;
          }

          case 'remove': {
            if (!input.name) { yield { type: 'error', message: 'remove requires "name".' }; return; }
            // A plugin's own store is that plugin's to withdraw: the def would go and its tool, which the
            // owner holds, would stay, until its next setup defined both again. Once the owner is no longer
            // loaded the def is a leftover, and removing it is housekeeping.
            const owner = (await meta.get(input.name))?.owner;
            if (owner !== undefined && services.tools.resolve(actionToolName(input.name))?.pluginName === owner) {
              yield { type: 'error', message: `Store "${input.name}" belongs to the plugin "${owner}", which exposes it; it is not this tool's to remove.` };
              return;
            }
            const removed = await meta.delete(input.name);
            if (removed) services.tools.remove(actionToolName(input.name));
            yield { type: 'result', value: { removed } };
            return;
          }

          case 'list': {
            yield { type: 'result', value: { stores: await listDefs(meta) } };
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(input.action)}". Expected: create, get, remove, list.` };
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

    // Re-register a tool for every managed store, so definitions survive a restart — except a plugin's own,
    // which that plugin registers from its own setup, and only while it is loaded.
    for (const def of await listDefs(meta)) {
      if (def.owner !== undefined && def.owner !== services.self?.name) continue;
      registerStoreTool(services, def);
    }
  },
};
