import type { MatbotPluginSpec, Session, SessionTypes, Tool, ToolContext, ToolContract, ToolEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { held, info, MAX_ENTRY_BYTES, remember, SESSION_DATA_CREATOR, type SessionDataEntry, type SessionDataInfo } from './entries.js';
import { shapeOf } from './shape.js';

export { MAX_ENTRY_BYTES, SESSION_DATA_CREATOR, type SessionDataEntry, type SessionDataInfo, type SessionDataMarker } from './entries.js';
export { shapeOf } from './shape.js';

export const TOOL_NAME = 'session_data';

/** What each entry of the session being checked holds, by id: this tool's key of `SessionTypes`, which only
 *  a check made on a session's behalf fills (from {@link sessionType}). Empty for a global function, which
 *  cannot know what any conversation holds. */
export type SessionDataEntries = SessionTypes extends { readonly session_data: infer E } ? E : Record<never, never>;

/** What `read` of `K` returns: the entry's type when the check knows it, else `unknown`. */
export type SessionDataRead<K extends string> = K extends keyof SessionDataEntries ? SessionDataEntries[K] : unknown;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    session_data:
      | ToolContract<SessionDataInfo, { action: 'write'; description: string; data: unknown }>
      | ToolContract<unknown, { action: 'read'; id: string }, <K extends string>(params: { action: 'read'; id: K }) => Promise<SessionDataRead<K>>>
      | ToolContract<SessionDataInfo[], { action: 'list' }>
      | ToolContract<{ dropped: string }, { action: 'drop'; id: string }>;
  }
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l/1/o/0: an id is copied by a model
const ID_LENGTH = 8;

function newId(taken: (id: string) => boolean): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = [...bytes].map(b => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
    if (!taken(id)) return id;
  }
}

const ALLOWED: Record<string, readonly string[]> = {
  write: ['action', 'description', 'data'],
  read:  ['action', 'id'],
  list:  ['action'],
  drop:  ['action', 'id'],
};

type Outcome = ToolEvent<unknown>;
const refuse = (message: string): Outcome => ({ type: 'error', message, failure: 'invalid' });

// A turn tool is not wrapped by the registry's executor, so no `validate` hook sees its input: it checks
// its own, and as strictly — an unknown property is a misspelt one.
function check(params: unknown): { action: string; p: Record<string, unknown> } | Outcome {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return refuse('session_data takes an object: { "action": "write" | "read" | "list" | "drop", … }.');
  const p = params as Record<string, unknown>;
  const action = p['action'];
  if (typeof action !== 'string' || !(action in ALLOWED)) return refuse(`"action" is one of write, read, list or drop${action === undefined ? '' : `, not ${JSON.stringify(action)}`}.`);
  const stray = Object.keys(p).filter(k => !ALLOWED[action]!.includes(k));
  if (stray.length > 0) return refuse(`"${action}" takes ${ALLOWED[action]!.map(k => `"${k}"`).join(', ')}; not ${stray.map(k => `"${k}"`).join(', ')}.`);
  return { action, p };
}

async function* execute(params: unknown, ctx: ToolContext): AsyncIterable<Outcome> {
  const checked = check(params);
  if ('type' in checked) { yield checked; return; }
  const { action, p } = checked;
  const now = held(ctx.session);

  switch (action) {
    case 'write': {
      // A `#` session is a door, not a conversation: nothing written there is kept, so an id would be a lie.
      if (ctx.session.id.startsWith('#')) { yield refuse('This call is not part of a conversation, so there is nowhere to keep data.'); return; }
      const description = p['description'];
      if (typeof description !== 'string' || description.trim() === '') { yield refuse('"write" needs a "description": what the data is, so it can be found again.'); return; }
      if (!('data' in p)) { yield refuse('"write" needs "data": the value to keep.'); return; }
      let json: string | undefined;
      try { json = JSON.stringify(p['data']); }
      catch (e) { yield refuse(`The data cannot be kept as JSON: ${e instanceof Error ? e.message : String(e)}.`); return; }
      if (json === undefined) { yield refuse('The data cannot be kept as JSON: it has no JSON form (undefined, or a function).'); return; }
      const bytes = new TextEncoder().encode(json).length;
      if (bytes > MAX_ENTRY_BYTES) {
        yield refuse(`This data is ${bytes} bytes and session_data holds at most ${MAX_ENTRY_BYTES}. Store the intermediate results using tools that accept data of ${bytes} bytes.`);
        return;
      }
      // What is kept is what JSON keeps (an `undefined` property gone, `NaN` as null), and a read now
      // returns exactly what a read after a restart will.
      const data: unknown = JSON.parse(json);
      const entry: SessionDataEntry = {
        id: newId(id => now.entries.has(id) || now.dropped.has(id)),
        description: description.trim(), shape: shapeOf(data), bytes, createdAt: new Date().toISOString(), data,
      };
      remember(ctx.session, { op: 'write', ...entry });
      yield { type: 'marker', creator: SESSION_DATA_CREATOR, data: { op: 'write', ...entry } };
      yield { type: 'result', value: info(entry) };
      return;
    }
    case 'read': {
      const id = p['id'];
      if (typeof id !== 'string') { yield refuse('"read" needs the "id" a write returned.'); return; }
      const entry = now.entries.get(id);
      if (entry !== undefined) { yield { type: 'result', value: entry.data }; return; }
      yield refuse(now.dropped.has(id)
        ? `Entry "${id}" was dropped.`
        : `This conversation holds no entry "${id}". ${now.entries.size > 0 ? `It holds: ${[...now.entries.keys()].join(', ')}.` : 'It holds none.'}`);
      return;
    }
    case 'list': {
      yield { type: 'result', value: [...now.entries.values()].map(info) };
      return;
    }
    case 'drop': {
      const id = p['id'];
      if (typeof id !== 'string') { yield refuse('"drop" needs the "id" of an entry.'); return; }
      if (!now.entries.has(id)) { yield refuse(now.dropped.has(id) ? `Entry "${id}" was dropped already.` : `This conversation holds no entry "${id}".`); return; }
      remember(ctx.session, { op: 'drop', id });
      yield { type: 'marker', creator: SESSION_DATA_CREATOR, data: { op: 'drop', id } };
      yield { type: 'result', value: { dropped: id } };
      return;
    }
    default:
      yield refuse(`Unknown action "${action}".`);
  }
}

/** This session's entries as a type, for one check: each id with the type inferred from its value when it
 *  was written. Exact, because an entry never changes. One lookup in a map rather than an overload per
 *  entry, so a check costs the same and a refusal reads the same however many a session holds. */
export function sessionType(session: Session): string | undefined {
  const entries = [...held(session).entries.values()];
  if (entries.length === 0) return undefined;
  return `{ ${entries.map(e => `${JSON.stringify(e.id)}: ${e.shape};`).join(' ')} }`;
}

const DESCRIPTION = `Keep a value in this conversation and read it back later by its id: an intermediate result (a query's rows, an aggregate) that a later step needs, without repeating it into the conversation. An entry belongs to the conversation: it is shared when the conversation is shared, goes with it when forked, and is gone if the conversation is cut back past where it was written. An entry never changes; write a new one instead. At most ${MAX_ENTRY_BYTES} bytes of JSON each.

Actions:
- write { description, data } → { id, description, shape, bytes, createdAt }. \`description\` says what the data is, so it can be found again; \`shape\` is its TypeScript type.
- read { id } → the data, as it was written. An id this conversation does not hold is an error.
- list → every entry held, without its data: how to find one written earlier.
- drop { id } → { dropped }.

Written and read from composed code, the data never passes through the conversation: write a tool's output where it is produced, and read it where it is used, by the id the write returned. Read by an id written as literal text, it is typed by what the entry holds.`;

// The description is the same in every conversation and every round: a tool definition that changed with
// each write would invalidate a provider's prompt cache for the whole conversation. What a conversation
// holds is found with `list`, and its types reach a check through `sessionType`.
export const sessionDataTool: Tool<unknown> = {
  name: TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action:      { type: 'string', enum: ['write', 'read', 'list', 'drop'] },
      id:          { type: 'string', description: 'read, drop: the id a write returned.' },
      description: { type: 'string', description: 'write: what the data is.' },
      data:        { description: 'write: the value to keep, any JSON.' },
    },
  },
  sessionType,
  executor: { execute },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'Keep intermediate results in a conversation and read them back by id (`session_data`: write/read/list/drop).' },
  tools: [sessionDataTool],
};
