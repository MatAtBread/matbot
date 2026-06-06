import type {
  MatbotPlugin, MatbotServices, Tool, ToolEvent, Session, Store, Message, Marker,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const PLUGIN_NAME = '@matatbread/matbot-edit-session';

// This plugin's marker payload, made type-safe by augmenting the shared MarkerData registry.
// Any reader narrowing on creator === PLUGIN_NAME gets the typed `data` for free.
declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    '@matatbread/matbot-edit-session': {
      /** 'split-from': earlier messages were split into peerSessionId (navigate back).
       *  'continued-in': this conversation continued in peerSessionId (navigate forward).
       *  'forked-from': this session was forked from peerSessionId (navigate to the origin). */
      relation:      'split-from' | 'continued-in' | 'forked-from';
      peerSessionId: string;
      /** Message index in peerSessionId to scroll to. Baked at edit time, so it's fragile to later
       *  inserts/removes in the peer — best-effort; the UI scrolls there only if it still resolves. */
      targetMsg:     number;
    };
  }
}

type EditSessionMarkerData = Marker<typeof PLUGIN_NAME>['data'];

// ── helpers ───────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

// A standalone marker message: opaque to the LLM (the 'marker' role is skipped by every provider
// converter), preserved by compaction, carried with the session for the UI to render as a
// cross-thread link.
function markerMessage(data: EditSessionMarkerData): Message {
  const marker: Marker<typeof PLUGIN_NAME> = { type: 'marker', creator: PLUGIN_NAME, data };
  return {
    id:        crypto.randomUUID(),
    role:      'marker',
    content:   [marker],
    createdAt: now(),
    traceId:   crypto.randomUUID(),
  };
}

function bumpVersion<T extends { version: string }>(doc: T): T {
  return { ...doc, version: crypto.randomUUID() };
}

// Resolve msgIndex (raw index into session.messages) to the actual index.
// The frontend passes the original message index from the full messages array.
function resolveIndex(session: Session, msgIndex: number): number | null {
  if (msgIndex < 0 || msgIndex >= session.messages.length) return null;
  return msgIndex;
}

function generateSplitTitle(title: string): string {
  // If title ends with " pt N", bump the number
  const match = title.match(/^(.*?)\s*pt\s+(\d+)$/);
  if (match && match.length > 2) {
    return `${match[1]?.trimEnd()} pt ${parseInt(match[2] ?? '0') + 1}`;
  }
  // Otherwise append " pt 2"
  return `${title || 'Untitled'} pt 2`;
}

// ── tool factories ────────────────────────────────────────────────────────────

function makeCutTool(store: Store<Session>): Tool {
  return {
    name:        'session_cut',
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
    name:        'session_fork',
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
        // One-way: only the fork is marked (pointing back to its origin). The original is left
        // unchanged, per this tool's contract.
        const forked: Session = {
          ...bumpVersion(session),
          id:               crypto.randomUUID(),
          parentSessionId:  sessionId,
          // targetMsg idx-1: the fork point in the (unchanged) parent — its last message shared with
          // this fork.
          messages:         [...session.messages.slice(0, idx), markerMessage({ relation: 'forked-from', peerSessionId: sessionId, targetMsg: Math.max(0, idx - 1) })],
          createdAt:        now(),
          updatedAt:        now(),
        };
        await store.set(forked.id, forked);
        yield { type: 'result', value: { newSessionId: forked.id, messagesCopied: idx } };
      },
    },
  };
}

function makeSplitTool(store: Store<Session>): Tool {
  return {
    name:        'session_split',
    description: 'Split a session at msgIndex: move messages before msgIndex into a new session and remove them from the current session. The current session keeps only messages from msgIndex onward.',
    inputSchema: {
      type:       'object',
      required:   ['sessionId', 'msgIndex'],
      properties: {
        sessionId: { type: 'string' },
        msgIndex:  { type: 'number', description: 'Split point: messages before this index are moved to a new session and removed from the current session.' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { sessionId, msgIndex } = input as { sessionId: string; msgIndex: number };
        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }
        if (idx === 0) {
          yield { type: 'error', message: 'Cannot split at index 0 — nothing to split off.' };
          return;
        }

        // Messages before the split point go to the new session
        const prefixMsgs = session.messages.slice(0, idx);

        // Messages from the split point onward stay in the current session
        const suffixMsgs = session.messages.slice(idx);

        const newSessionId = crypto.randomUUID();

        // Create the new session with the prefix messages, tailed by a marker pointing forward to
        // the continuing (current) session.
        const newSession: Session = {
          ...bumpVersion(session),
          id:               newSessionId,
          parentSessionId:  sessionId,
          // targetMsg 1: in the current session the prepended split-from marker is index 0, so the
          // continuation (first suffix message) lands at index 1.
          messages:         [...prefixMsgs, markerMessage({ relation: 'continued-in', peerSessionId: sessionId, targetMsg: 1 })],
          createdAt:        now(),
          updatedAt:        now(),
        };
        await store.set(newSession.id, newSession);

        // Update the current session to keep only suffix messages, headed by a marker pointing back
        // to where the earlier messages now live.
        const updated: Session = bumpVersion({
          ...session,
          title:     generateSplitTitle(session.title ?? ''),
          // targetMsg idx-1: the last earlier message in the new session (its prefix is messages
          // 0..idx-1, then the continued-in marker).
          messages:  [markerMessage({ relation: 'split-from', peerSessionId: newSessionId, targetMsg: idx - 1 }), ...suffixMsgs],
          updatedAt: now(),
        });
        const res = await store.cas(sessionId, session.version, updated);
        if (!res.ok) {
          // CAS failed — clean up the new session we just created
          await store.delete(newSession.id);
          yield { type: 'error', message: 'Concurrent modification — please retry.' };
          return;
        }

        yield {
          type: 'result',
          value: {
            newSessionId: newSession.id,
            messagesSplit: prefixMsgs.length,
            currentSessionId: sessionId,
            messagesRemaining: suffixMsgs.length,
          },
        };
      },
    },
  };
}

const KEEP_TYPES = new Set(['text', 'refusal', 'marker']);

function makeCompactTool(store: Store<Session>): Tool {
  return {
    name:        'session_compact',
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
  name:       PLUGIN_NAME,
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    const store = services.sessions;
    if (!store) return;
    for (const tool of [makeCutTool(store), makeForkTool(store), makeSplitTool(store), makeCompactTool(store)]) {
      services.tools.register(tool);
    }
  },
};
