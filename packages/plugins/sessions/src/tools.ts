import type { Tool, ToolEvent, Session, Store } from '@matatbread/matbot-plugin-api';

function sessionPreview(session: Session): string {
  const first = session.messages.find(m => m.role === 'user');
  const text  = first?.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )?.text ?? '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function makeSessionTools(store: Store<Session>): readonly Tool[] {
  return [makeListTool(store), makeGetTool(store), makeRenameTool(store), makeHideTool(store)];
}

function makeListTool(store: Store<Session>): Tool {
  return {
    name:        'session_list',
    description: 'List conversation sessions.',
    inputSchema: {
      type:       'object',
      properties: {
        includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { includeArchived } = (input ?? {}) as { includeArchived?: boolean };
        const { items } = await store.query(
          includeArchived ? {} : { filter: { field: 'status', op: 'neq', value: 'archived' } },
        );
        const sorted = items.slice().sort((a, b) => b.doc.updatedAt.localeCompare(a.doc.updatedAt));
        yield {
          type:  'result',
          value: sorted.map(({ doc: s }) => ({
            id:        s.id,
            title:     s.title,
            preview:   sessionPreview(s),
            updatedAt: s.updatedAt,
          })),
        };
      },
    },
  };
}

function makeGetTool(store: Store<Session>): Tool {
  return {
    name:        'session_get',
    description: 'Get a conversation session by ID.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'ID of the session to retrieve.' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId } = input as { sessionId: string };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        yield { type: 'result', value: session };
      },
    },
  };
}

function makeRenameTool(store: Store<Session>): Tool {
  return {
    name:        'session_rename',
    description: 'Rename a conversation session.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId', 'title'],
      properties: {
        sessionId: { type: 'string', description: 'ID of the session to rename.' },
        title:     { type: 'string', description: 'New title for the session.' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId, title } = input as { sessionId: string; title: string };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const next = { ...session, title, version: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        const res  = await store.cas(sessionId, session.version, next);
        if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
        yield { type: 'result', value: { id: sessionId, title } };
      },
    },
  };
}

function makeHideTool(store: Store<Session>): Tool {
  return {
    name:        'session_hide',
    description: 'Hide (archive) a conversation session so it no longer appears in the session list.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'ID of the session to hide.' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId } = input as { sessionId: string };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const next = { ...session, status: 'archived' as const, version: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        const res  = await store.cas(sessionId, session.version, next);
        if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
        yield { type: 'result', value: { id: sessionId, status: 'archived' } };
      },
    },
  };
}
