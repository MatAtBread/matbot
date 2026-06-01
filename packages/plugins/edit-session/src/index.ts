import type {
  MatbotPlugin, MatbotServices, Tool, ToolEvent, Session, Store,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// ── helpers ───────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

function bumpVersion<T extends { version: string }>(doc: T): T {
  return { ...doc, version: crypto.randomUUID() };
}

// Resolve msgIndex (raw index into session.messages) to the actual index.
// The frontend passes the original message index from the full messages array.
function resolveIndex(session: Session, msgIndex: number): number | null {
  if (msgIndex < 0 || msgIndex >= session.messages.length) return null;
  return msgIndex;
}

// ── tool factories ────────────────────────────────────────────────────────────

function makeCutTool(store: Store<Session>): Tool {
  return {
    name:        'edit_session_cut',
    description: 'Remove all messages from msgIndex onward, truncating the session at that point.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId', 'msgIndex'],
      properties: {
        sessionId: { type: 'string' },
        msgIndex:  { type: 'number', description: 'Index in session.messages to cut from (inclusive).' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId, msgIndex } = input as { sessionId: string; msgIndex: number };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }
        const next: Session = bumpVersion({
          ...session,
          messages:  session.messages.slice(0, idx),
          updatedAt: now(),
        });
        const res = await store.cas(sessionId, session.version, next);
        if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
        yield { type: 'result', value: { sessionId, messagesRemaining: next.messages.length } };
      },
    },
  };
}

function makeForkTool(store: Store<Session>): Tool {
  return {
    name:        'edit_session_fork',
    description: 'Create a new session containing messages before msgIndex, leaving the original unchanged.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId', 'msgIndex'],
      properties: {
        sessionId: { type: 'string' },
        msgIndex:  { type: 'number', description: 'Fork point: new session gets messages[0..msgIndex-1].' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId, msgIndex } = input as { sessionId: string; msgIndex: number };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }
        const forked: Session = {
          ...bumpVersion(session),
          id:               crypto.randomUUID(),
          parentSessionId:  sessionId,
          messages:         session.messages.slice(0, idx),
          createdAt:        now(),
          updatedAt:        now(),
        };
        await store.set(forked.id, forked);
        yield { type: 'result', value: { newSessionId: forked.id, messagesCopied: forked.messages.length } };
      },
    },
  };
}

const KEEP_TYPES = new Set(['text', 'refusal']);

function makeCompactTool(store: Store<Session>): Tool {
  return {
    name:        'edit_session_compact',
    description: 'Strip thinking blocks, tool calls, and tool results from messages before msgIndex, keeping all user/assistant text so context is preserved but token count is reduced.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId', 'msgIndex'],
      properties: {
        sessionId: { type: 'string' },
        msgIndex:  { type: 'number', description: 'Strip verbose content from messages[0..msgIndex-1].' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId, msgIndex } = input as { sessionId: string; msgIndex: number };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null || idx === 0) {
          yield { type: 'error', message: `msgIndex ${msgIndex} out of range or nothing to compact.` };
          return;
        }
        let stripped = 0;
        const messages = session.messages.map((m, i) => {
          if (i >= idx) return m;
          const compact = m.content.filter(c => KEEP_TYPES.has(c.type));
          if (compact.length === m.content.length) return m;
          stripped++;
          return { ...m, content: compact };
        });
        const next: Session = bumpVersion({ ...session, messages, updatedAt: now() });
        const res = await store.cas(sessionId, session.version, next);
        if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
        yield { type: 'result', value: { sessionId, messagesStripped: stripped } };
      },
    },
  };
}

// ── plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-edit-session',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    const store = services.sessions;
    if (!store) return;
    for (const tool of [makeCutTool(store), makeForkTool(store), makeCompactTool(store)]) {
      services.tools.register(tool);
    }
  },
};
