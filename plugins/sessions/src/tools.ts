import type { Tool, ToolContract, ToolResultOf, ToolContext, Session, Store, Filter, StoreQuery, FieldPath } from '@matatbread/matbot-plugin-api';
import { lastActivityAt, StoreQueryError } from '@matatbread/matbot-plugin-api';
import { compileFilter, applySort, validateQuery, decodeCursor, encodeCursor, type PageState } from '@matatbread/matbot-core/storage-base';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'session_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    session_action:
      | ToolContract<Array<{ id: string; title: string | undefined; preview: string; updatedAt: string }>, { action: 'list'; includeArchived?: boolean }>
      | ToolContract<
          { items: Array<{ id: string; title: string | undefined; preview: string; updatedAt: string }>; cursor?: string; total?: number },
          { action: 'query' } & StoreQuery
        >
      | ToolContract<Session,                          { action: 'get'; sessionId: string }>
      | ToolContract<{ id: string; title: string },    { action: 'rename'; sessionId: string; title: string }>
      | ToolContract<{ id: string; status: 'archived' }, { action: 'hide'; sessionId: string }>;
  }
}

type SessionSummary = { id: string; title: string | undefined; preview: string; updatedAt: string };

function sessionPreview(session: Session): string {
  const first = session.messages.find(m => m.role === 'user');
  const text  = first?.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )?.text ?? '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function toSummary(s: Session): SessionSummary {
  return { id: s.id, title: s.title, preview: sessionPreview(s), updatedAt: s.updatedAt };
}

// Synthesized, lowercased "columns" holding the conversation text per authorship role — matbot's
// pretend fields for the query grammar, since the real text is buried in messages[].content[].
// Only `type:'text'` blocks count; tool calls/results, thinking, images and markers are dropped as noise.
function synthRoles(s: Session): { user: string; assistant: string } {
  let user = '', assistant = '';
  for (const m of s.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    for (const c of m.content) {
      if (c.type !== 'text') continue;
      if (m.role === 'user') user      += (user      ? '\n' : '') + c.text;
      else                   assistant += (assistant ? '\n' : '') + c.text;
    }
  }
  return { user: user.toLowerCase(), assistant: assistant.toLowerCase() };
}

// Case-insensitive match over the synthesized fields: they are stored lowercased, so lowercase the
// operand of any `stringContains` that targets one (recursing through and/or/not). Real stored fields
// (status/title/…) keep exact semantics — we only touch `user`/`assistant`.
const SYNTH_FIELDS = new Set(['user', 'assistant']);
function oneKey(field: FieldPath): string | undefined {
  const segs = Array.isArray(field) ? field : [field];
  return segs.length === 1 ? segs[0] : undefined;
}
function lowerSynthOperands(f: Filter): Filter {
  switch (f.op) {
    case 'and':
    case 'or':  return { op: f.op, clauses: f.clauses.map(lowerSynthOperands) };
    case 'not': return { op: 'not', clause: lowerSynthOperands(f.clause) };
    case 'stringContains':
      return SYNTH_FIELDS.has(oneKey(f.field) ?? '') ? { ...f, value: f.value.toLowerCase() } : f;
    default:    return f;
  }
}

export function makeSessionTools(store: Store<Session>): readonly Tool[] {
  return [makeSessionActionTool(store)];
}

// The precise per-action contract. JSON Schema can't express "title required only for rename"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SessionInput =
  | { action: 'list';   includeArchived?: boolean }
  | ({ action: 'query' } & StoreQuery)
  | { action: 'get';    sessionId: string }
  | { action: 'rename'; sessionId: string; title: string }
  | { action: 'hide';   sessionId: string };

function makeSessionActionTool(store: Store<Session>): Tool<ToolResultOf<'session_action'>> {
  return {
    name: 'session_action',
    description:
      'Manage conversation sessions. A session is a stored conversation — a chronological list of ' +
      'messages identified by a unique ID, with a title and a status (active or archived). This tool ' +
      'covers the lifecycle: list sessions, search their contents (query), fetch one in full (get), ' +
      'rename one, or hide (archive) one.\n\n' +
      '"list" and "query" return lightweight summaries — each item\'s "preview" is just the session\'s ' +
      'first user message truncated to 60 characters (empty if it has no text), a display label, not a ' +
      'summary of the conversation. To read a session\'s contents, use "get".\n\n' +
      '"query" searches with the store query grammar. Two synthesized string fields hold the conversation ' +
      'text and are matched case-insensitively: "user" (everything the user said) and "assistant" ' +
      '(everything the assistant said) — e.g. sessions where the user mentioned invoices: ' +
      '{ where: { op: "stringContains", field: "user", value: "invoice" } }. Search both sides by OR-ing ' +
      'a clause on each field. The stored fields "status", "title", "createdAt" and "updatedAt" are also ' +
      'queryable (eq/neq/in/lt/lte/gt/gte/exists), combinable with and/or/not. Optional "sort" (stored ' +
      'fields only, e.g. [{ field: "updatedAt", dir: "desc" }]), "limit" (the search early-exits once this ' +
      'many match), and "cursor" (from a previous result) paginate.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:          { type: 'string', enum: ['list', 'query', 'get', 'rename', 'hide'], description: 'The operation to perform.' },
        sessionId:       { type: 'string', description: 'ID of the target session. Required for get/rename/hide.' },
        title:           { type: 'string', description: 'New title — required for action "rename".' },
        includeArchived: { type: 'boolean', description: 'list only: include archived sessions. Default false.' },
        where:           { type: 'object', description: 'query only: a store-query Filter over "user"/"assistant" (session text) and stored fields. See description.' },
        sort:            { type: 'array',  description: 'query only: SortSpec[] over stored fields, e.g. [{ "field": "updatedAt", "dir": "desc" }].' },
        limit:           { type: 'number', description: 'query only: max results — the search early-exits once this many match.' },
        cursor:          { type: 'string', description: 'query only: opaque cursor from a previous query result, for the next page.' },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext) {
        const args = input as Partial<SessionInput> & { action?: string };

        switch (args.action) {
          case 'list': {
            const { includeArchived } = args as Extract<SessionInput, { action: 'list' }>;
            const { items } = await store.query(
              includeArchived ? {} : { where: { op: 'neq', field: 'status', value: 'archived' } },
            );
            const sorted = items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            yield { type: 'result', value: sorted.map(toSummary) };
            return;
          }

          case 'query': {
            const { where, sort, limit, cursor } = args as Extract<SessionInput, { action: 'query' }>;

            // A cursor fully determines its page (its `where` was already normalized when encoded);
            // otherwise take the caller's clauses, lowercasing synth-field operands for case-insensitivity.
            let page: PageState;
            try {
              if (cursor !== undefined) {
                page = decodeCursor(cursor);
                validateQuery({
                  ...(page.where !== undefined ? { where: page.where } : {}),
                  ...(page.sort  !== undefined ? { sort:  page.sort  } : {}),
                  ...(page.limit !== undefined ? { limit: page.limit } : {}),
                });
              } else {
                const q: StoreQuery = {
                  ...(where !== undefined ? { where: lowerSynthOperands(where) } : {}),
                  ...(sort  !== undefined ? { sort  } : {}),
                  ...(limit !== undefined ? { limit } : {}),
                };
                validateQuery(q);
                page = {
                  offset: 0,
                  ...(q.where !== undefined ? { where: q.where } : {}),
                  ...(q.sort  !== undefined ? { sort:  q.sort  } : {}),
                  ...(q.limit !== undefined ? { limit: q.limit } : {}),
                };
              }
            } catch (e) {
              if (e instanceof StoreQueryError) { yield { type: 'error', message: `${e.message} (at ${e.pointer})` }; return; }
              throw e;
            }

            const { items } = await store.query({});
            const ordered   = applySort(items, page.sort);   // stored-field ordering, before any text synthesis
            const match     = page.where !== undefined ? compileFilter(page.where) : () => true;

            // The for-loop with the early break: synthesize + test one session at a time and stop the
            // moment the page is full, so a low `limit` over hundreds of sessions never searches the tail.
            const rows: SessionSummary[] = [];
            let matched = 0;
            for (const s of ordered) {
              if (page.limit !== undefined && rows.length >= page.limit) break;
              if (!match({ ...s, ...synthRoles(s) })) continue;
              if (matched++ >= page.offset) rows.push(toSummary(s));
            }

            // Optimistic cursor: emitted whenever the page filled, so the next page may be empty — the
            // price of early-exit (we don't scan on to confirm a further match exists). `total` is omitted
            // for the same reason: we never counted the tail.
            const nextPage = (page.limit !== undefined && rows.length >= page.limit)
              ? { cursor: encodeCursor({ ...page, offset: page.offset + page.limit }) }
              : {};
            yield { type: 'result', value: { items: rows, ...nextPage } };
            return;
          }

          case 'get': {
            const { sessionId } = args as Extract<SessionInput, { action: 'get' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "get" requires "sessionId".' }; return; }
            // Pure committed history. Pending submissions and the in-progress response are the live
            // "delta" delivered over the runner's event stream, never overlaid onto stored state.
            const session = await store.get(sessionId);
            if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
            yield { type: 'result', value: session };
            return;
          }

          case 'rename': {
            const { sessionId, title } = args as Extract<SessionInput, { action: 'rename' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "rename" requires "sessionId".' }; return; }
            if (title === undefined) { yield { type: 'error', message: 'action "rename" requires "title".' }; return; }
            const session = await store.get(sessionId);
            if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
            // Rename is a metadata edit, not conversational activity: keep updatedAt on the last message
            // (the lastActivityAt invariant) so renaming doesn't float the session up a recency-sorted list.
            const next = { ...session, title, version: crypto.randomUUID(), updatedAt: lastActivityAt(session) };
            const res  = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { id: sessionId, title } };
            return;
          }

          case 'hide': {
            const { sessionId } = args as Extract<SessionInput, { action: 'hide' }>;
            if (!sessionId) { yield { type: 'error', message: 'action "hide" requires "sessionId".' }; return; }
            const session = await store.get(sessionId);
            if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
            // Archiving is a status edit, not conversational activity — preserve updatedAt (lastActivityAt).
            const next = { ...session, status: 'archived' as const, version: crypto.randomUUID(), updatedAt: lastActivityAt(session) };
            const res  = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { id: sessionId, status: 'archived' } };
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, query, get, rename, hide.` };
        }
      },
    },
  };
}
