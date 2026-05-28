import type { Tool, ToolEvent, Session, Store } from '@matatbread/matbot-plugin-api';

export function makeSessionTools(store: Store<Session>): readonly Tool[] {
  return [makeRenameTool(store), makeHideTool(store)];
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
