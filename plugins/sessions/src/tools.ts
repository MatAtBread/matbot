import type { Tool, ToolResult, ToolResultOf, ToolContext, Session, Store } from '@matatbread/matbot-plugin-api';
import { lastActivityAt } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    // One arm per action: a caller of `invokeTool(machine, 'session_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolResult / the multi-action note on ToolResults).
    session_action:
      | ToolResult<Array<{ id: string; title: string | undefined; preview: string; updatedAt: string }>, { action: 'list'   }>
      | ToolResult<Session,                          { action: 'get'    }>
      | ToolResult<{ id: string; title: string },    { action: 'rename' }>
      | ToolResult<{ id: string; status: 'archived' }, { action: 'hide'  }>;
  }
}

function sessionPreview(session: Session): string {
  const first = session.messages.find(m => m.role === 'user');
  const text  = first?.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )?.text ?? '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function makeSessionTools(store: Store<Session>): readonly Tool[] {
  return [makeSessionActionTool(store)];
}

// The precise per-action contract. JSON Schema can't express "title required only for rename"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SessionInput =
  | { action: 'list';   includeArchived?: boolean }
  | { action: 'get';    sessionId: string }
  | { action: 'rename'; sessionId: string; title: string }
  | { action: 'hide';   sessionId: string };

function makeSessionActionTool(store: Store<Session>): Tool<ToolResultOf<'session_action'>> {
  return {
    name: 'session_action',
    description:
      'Manage conversation sessions. A session is a stored conversation — an chronological list of ' +
      'messages identified by a unique ID, with a title and a status (active or archived). This ' +
      'tool covers the lifecycle: list sessions, fetch one in full, rename one, or hide (archive) ' +
      'one.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type SessionAction =\n' +
      "  | { action: 'list';   includeArchived?: boolean }          // -> [{ id, title, preview, updatedAt }]\n" +
      "  | { action: 'get';    sessionId: string }                  // -> the full session\n" +
      "  | { action: 'rename'; sessionId: string; title: string }   // -> { id, title }\n" +
      "  | { action: 'hide';   sessionId: string };                 // -> { id, status: 'archived' }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:          { type: 'string', enum: ['list', 'get', 'rename', 'hide'], description: 'The operation to perform.' },
        sessionId:       { type: 'string', description: 'ID of the target session. Required for get/rename/hide.' },
        title:           { type: 'string', description: 'New title — required for action "rename".' },
        includeArchived: { type: 'boolean', description: 'list only: include archived sessions. Default false.' },
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
            yield {
              type:  'result',
              value: sorted.map(s => ({
                id:        s.id,
                title:     s.title,
                preview:   sessionPreview(s),
                updatedAt: s.updatedAt,
              })),
            };
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
            yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, get, rename, hide.` };
        }
      },
    },
  };
}

