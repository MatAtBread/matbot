import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolContract, ToolContext, ToolResultOf, Session, Store, Message, Marker,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, lastActivityAt } from '@matatbread/matbot-plugin-api';

import { makeCompactSessionsTool } from './compact-sessions.js'

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'session_edit', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    session_edit:
      | ToolContract<{ sessionId: string; messagesRemaining: number },                                                     { action: 'cut';     sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesCopied: number },                                                     { action: 'fork';    sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesSplit: number; currentSessionId: string; messagesRemaining: number }, { action: 'split';   sessionId: string; msgIndex: number }>
      | ToolContract<{ sessionId: string; messagesStripped: number },                                                      { action: 'compact'; sessionId: string; msgIndex: number }>;
  }
}

const MARKER_CREATOR = '@matatbread/matbot-edit-session';

// This plugin's marker payload, made type-safe by augmenting the shared MarkerData registry.
// Any reader narrowing on creator === MARKER_CREATOR gets the typed `data` for free.
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

type EditSessionMarkerData = Marker<typeof MARKER_CREATOR>['data'];

// ── helpers ───────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

// A standalone marker message: opaque to the LLM (the 'marker' role is skipped by every provider
// converter), preserved by compaction, carried with the session for the UI to render as a
// cross-thread link.
function markerMessage(data: EditSessionMarkerData): Message {
  const marker: Marker<typeof MARKER_CREATOR> = { type: 'marker', creator: MARKER_CREATOR, data };
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
  if (msgIndex < 0) msgIndex = session.messages.length + msgIndex;
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

const KEEP_TYPES = new Set(['text', 'refusal', 'marker']);

// ── tool ──────────────────────────────────────────────────────────────────────

// All four actions share the same parameter shape ({ sessionId, msgIndex }); only the behaviour
// differs. The schema stays loose (action enum + the shared fields) and the description carries
// this TypeScript signature, which the executor enforces.
interface SessionEditInput { action: 'cut' | 'fork' | 'split' | 'compact'; sessionId: string; msgIndex: number }

function makeSessionEditTool(store: Store<Session>): Tool<ToolResultOf<'session_edit'>> {
  return {
    name: 'session_edit',
    description:
      'Edit the message history of a session (see `session_action` for what a session is). Every ' +
      'action takes a session ID and a message index (`msgIndex`, an index into session.messages) ' +
      'and uses it to manage the conversation\'s length and structure:\n' +
      '  cut     — Truncate: remove all messages from msgIndex onward.\n' +
      '  fork    — Branch: create a NEW session with messages[0..msgIndex-1]; the original is unchanged.\n' +
      '  split   — Move: messages before msgIndex move to a new session; the current session keeps\n' +
      '            msgIndex onward. Both sides get cross-link markers.\n' +
      '  compact — Shrink: strip thinking blocks, tool calls, and tool results from messages before\n' +
      '            msgIndex, keeping user/assistant text — fewer tokens, same thread.\n' +
      'The session the current turn is running in cannot be cut, split or compacted: the turn owns that ' +
      'document until it commits. Only `fork` (which writes a new session) is available on it.',
    inputSchema: {
      type:       'object',
      required:   ['action', 'sessionId', 'msgIndex'],
      properties: {
        action:    { type: 'string', enum: ['cut', 'fork', 'split', 'compact'], description: 'The edit to perform.' },
        sessionId: { type: 'string', description: 'ID of the session to edit.' },
        msgIndex:  { type: 'number', description: 'Index into session.messages the action pivots on (see per-action meaning in the description). Like slice index, negative is an offset from the end of the session.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const { action, sessionId, msgIndex } = input as Partial<SessionEditInput>;
        if (!sessionId) { yield { type: 'error', message: 'session_edit requires "sessionId".' }; return; }
        if (typeof msgIndex !== 'number') { yield { type: 'error', message: 'session_edit requires "msgIndex" (number).' }; return; }

        // The running turn owns its session document: the runner takes one in-memory copy at turn start
        // and writes it back unconditionally at turn end, so a write landing here is overwritten seconds
        // later — silently, since that write is not a CAS. `split` fails worse than the rest: its new
        // session survives while the truncation of this one does not, leaving a dangling half. Refuse,
        // rather than report a success that will not survive the turn. `fork` is exempt — it only writes
        // a new document — though it forks the committed state, without this turn's uncommitted tail.
        if (sessionId === ctx.session.id && (action === 'cut' || action === 'split' || action === 'compact')) {
          yield { type: 'error', message:
            `Cannot ${action} session "${sessionId}": it is the session this turn is running in, and the ` +
            'turn owns it until it commits — the edit would be overwritten when the turn ends. Edit it ' +
            'outside a turn, or use action "fork" (writes a new session, leaves this one untouched).' };
          return;
        }

        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }

        switch (action) {
          case 'cut': {
            const trimmed: Session = { ...session, messages: session.messages.slice(0, idx) };
            const next: Session = bumpVersion({ ...trimmed, updatedAt: lastActivityAt(trimmed) });
            const res = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { sessionId, messagesRemaining: next.messages.length } };
            return;
          }

          case 'fork': {
            // One-way: only the fork is marked (pointing back to its origin). The original is left
            // unchanged, per this action's contract.
            // targetMsg idx-1: the fork point in the (unchanged) parent — its last message shared with
            // this fork. The marker is the fork's last message, so its timestamp is the fork's updatedAt.
            const forkMarker = markerMessage({ relation: 'forked-from', peerSessionId: sessionId, targetMsg: Math.max(0, idx - 1) });
            const forked: Session = {
              ...bumpVersion(session),
              id:               crypto.randomUUID(),
              parentSessionId:  sessionId,
              messages:         [...session.messages.slice(0, idx), forkMarker],
              createdAt:        now(),
              updatedAt:        forkMarker.createdAt,
            };
            await store.set(forked.id, forked);
            yield { type: 'result', value: { newSessionId: forked.id, messagesCopied: idx } };
            return;
          }

          case 'split': {
            if (idx === 0) { yield { type: 'error', message: 'Cannot split at index 0 — nothing to split off.' }; return; }

            // Messages before the split point go to the new session
            const prefixMsgs = session.messages.slice(0, idx);
            // Messages from the split point onward stay in the current session
            const suffixMsgs = session.messages.slice(idx);

            const newSessionId = crypto.randomUUID();

            // New session: prefix messages, tailed by a marker pointing forward to the continuing
            // (current) session. The marker is its last message, hence its updatedAt.
            // targetMsg 1: in the current session the prepended split-from marker is index 0, so the
            // continuation (first suffix message) lands at index 1.
            const continuedMarker = markerMessage({ relation: 'continued-in', peerSessionId: sessionId, targetMsg: 1 });
            const newSession: Session = {
              ...bumpVersion(session),
              id:               newSessionId,
              parentSessionId:  sessionId,
              messages:         [...prefixMsgs, continuedMarker],
              createdAt:        now(),
              updatedAt:        continuedMarker.createdAt,
            };
            await store.set(newSession.id, newSession);

            // Current session: keep only suffix messages, headed by a marker pointing back to where
            // the earlier messages now live. Its tail (the last suffix message) is unchanged, so by the
            // lastActivityAt invariant updatedAt is preserved — the split doesn't reorder this session.
            // targetMsg idx-1: the last earlier message in the new session.
            const continued: Session = {
              ...session,
              title:    generateSplitTitle(session.title ?? ''),
              messages: [markerMessage({ relation: 'split-from', peerSessionId: newSessionId, targetMsg: idx - 1 }), ...suffixMsgs],
            };
            const updated: Session = bumpVersion({ ...continued, updatedAt: lastActivityAt(continued) });
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
                newSessionId:      newSession.id,
                messagesSplit:     prefixMsgs.length,
                currentSessionId:  sessionId,
                messagesRemaining: suffixMsgs.length,
              },
            };
            return;
          }

          case 'compact': {
            if (idx === 0) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range or nothing to compact.` }; return; }
            let stripped = 0;
            const messages = session.messages.map((m, i) => {
              if (i >= idx) return m;
              const compact = m.content.filter(c => KEEP_TYPES.has(c.type));
              if (compact.length === m.content.length) return m;
              stripped++;
              return { ...m, content: compact };
            });
            // Compaction strips block content but preserves every message (and its timestamp), so the
            // tail is unchanged and updatedAt holds — the session keeps its place in a recency-sorted list.
            const compacted: Session = { ...session, messages };
            const next: Session = bumpVersion({ ...compacted, updatedAt: lastActivityAt(compacted) });
            const res = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { sessionId, messagesStripped: stripped } };
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(action)}". Expected one of: cut, fork, split, compact.` };
        }
      },
    },
  };
}

// ── plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    const store = services.sessions;
    if (!store) return;
    services.tools.register(makeSessionEditTool(store));
    services.tools.register(makeCompactSessionsTool(store));
  },
};
