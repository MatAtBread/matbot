import type {
  MatbotPluginSpec, MatbotMachine, Principal, Tool, ToolContract, ToolContext, ToolResultOf, Session, Store, Message, Marker,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, lastActivityAt, currentPrincipal, runAs } from '@matatbread/matbot-plugin-api';

import { makeCompactSessionsTool } from './compact-sessions.js'
import { compactBefore } from './compaction.js'
import { defer } from './defer.js'

/** An edit of the session the calling turn is running in: applied at the quiescent edge, after the
 *  turn writes its own document back. The tool cannot report its outcome — awaiting the edge from
 *  inside the turn that has to end to reach it is a deadlock — so the result says only that the work
 *  is queued. */
interface DeferredEdit { deferred: true; sessionId: string; message: string }

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'session_edit', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    session_edit:
      | ToolContract<{ sessionId: string; messagesRemaining: number } | DeferredEdit,                                                     { action: 'cut';     sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesCopied: number },                                                                    { action: 'fork';    sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesSplit: number; currentSessionId: string; messagesRemaining: number } | DeferredEdit, { action: 'split';   sessionId: string; msgIndex: number }>
      | ToolContract<{ sessionId: string; messagesStripped: number } | DeferredEdit,                                                      { action: 'compact'; sessionId: string; msgIndex: number }>;
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

// ── tool ──────────────────────────────────────────────────────────────────────

// All four actions share the same parameter shape ({ sessionId, msgIndex }); only the behaviour
// differs. The schema stays loose (action enum + the shared fields) and the description carries
// this TypeScript signature, which the executor enforces.
interface SessionEditInput { action: 'cut' | 'fork' | 'split' | 'compact'; sessionId: string; msgIndex: number }

type EditOutcome =
  | { ok: true;  value: ToolResultOf<'session_edit'> }
  | { ok: false; message: string };

// Reads the document itself, so it is equally correct called inline (the tool call) or later from the
// quiescent edge (the deferred self-edit) — the deferred path must NOT close over a session read
// before the turn committed, which is exactly the state the turn is about to overwrite.
async function applyEdit(store: Store<Session>, action: SessionEditInput['action'] | undefined, sessionId: string, msgIndex: number): Promise<EditOutcome> {
  const session = await store.get(sessionId);
  if (!session) return { ok: false, message: `Session "${sessionId}" not found.` };
  const idx = resolveIndex(session, msgIndex);
  if (idx === null) return { ok: false, message: `msgIndex ${msgIndex} out of range.` };

  switch (action) {
    case 'cut': {
      const trimmed: Session = { ...session, messages: session.messages.slice(0, idx) };
      const next: Session = bumpVersion({ ...trimmed, updatedAt: lastActivityAt(trimmed) });
      const res = await store.cas(sessionId, session.version, next);
      if (!res.ok) return { ok: false, message: 'Concurrent modification — please retry.' };
      return { ok: true, value: { sessionId, messagesRemaining: next.messages.length } };
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
      return { ok: true, value: { newSessionId: forked.id, messagesCopied: idx } };
    }

    case 'split': {
      if (idx === 0) return { ok: false, message: 'Cannot split at index 0 — nothing to split off.' };

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
        return { ok: false, message: 'Concurrent modification — please retry.' };
      }

      return {
        ok: true,
        value: {
          newSessionId:      newSession.id,
          messagesSplit:     prefixMsgs.length,
          currentSessionId:  sessionId,
          messagesRemaining: suffixMsgs.length,
        },
      };
    }

    case 'compact': {
      if (idx === 0) return { ok: false, message: `msgIndex ${msgIndex} out of range or nothing to compact.` };
      const { messages, stripped } = compactBefore(session.messages, idx);
      // Compaction never touches the tail (it stops at idx), so updatedAt holds and the session keeps
      // its place in a recency-sorted list — even though the messages it does touch may disappear.
      // Nothing addresses a message by position across a reload; the sole exception is this plugin's
      // own cross-session `targetMsg`, already best-effort.
      const compacted: Session = { ...session, messages };
      const next: Session = bumpVersion({ ...compacted, updatedAt: lastActivityAt(compacted) });
      const res = await store.cas(sessionId, session.version, next);
      if (!res.ok) return { ok: false, message: 'Concurrent modification — please retry.' };
      return { ok: true, value: { sessionId, messagesStripped: stripped } };
    }

    default:
      return { ok: false, message: `Unknown action "${String(action)}". Expected one of: cut, fork, split, compact.` };
  }
}

async function applyDeferred(store: Store<Session>, principal: Principal, action: SessionEditInput['action'], sessionId: string, msgIndex: number): Promise<void> {
  // Restore the caller's identity: the edge runs outside every principal scope, and the store reads
  // and writes below are the same ownership-checked operations the inline path performs.
  await runAs(principal, async () => {
    const outcome = await applyEdit(store, action, sessionId, msgIndex);
    // Nothing left to report to: the caller's turn ended to reach this edge. A CAS conflict here means
    // a writer got in between, and losing the edit is the honest outcome — it is not this plugin's job
    // to fight for the document.
    if (!outcome.ok) console.error(`[session_edit] deferred ${action} of session "${sessionId}" failed: ${outcome.message}`);
  });
}

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
      '            msgIndex, keeping user/assistant text — fewer tokens, same thread. A message left\n' +
      '            with no content is removed, so earlier indices shift; re-read the session before\n' +
      '            using a msgIndex you read from it beforehand.\n' +
      'Cutting, splitting or compacting the session the current turn is running in is DEFERRED: the turn ' +
      'owns that document until it commits, so the edit is queued and applied once the turn ends. The ' +
      'result says `deferred: true` and carries no counts — they are not knowable yet. Do not re-issue it, ' +
      'and do not read the session back this turn to check: it still holds the pre-edit history. `fork` is ' +
      'immediate on any session (it only writes a new document), but forks the committed state, without ' +
      'this turn\'s uncommitted tail.',
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
        // later — silently, since that write is not a CAS. So defer to the quiescent edge, where the
        // turn's write-back has already happened and the edit reads the committed document.
        // The outcome cannot be reported: the edge is reached only once this turn has ended, so awaiting
        // it from inside the turn would deadlock. The result says "queued" and nothing more. `fork` is
        // exempt — it only writes a new document.
        if (sessionId === ctx.session.id && (action === 'cut' || action === 'split' || action === 'compact')) {
          const principal = currentPrincipal();
          // Resolve a negative (from-the-end) index NOW, against the turn's own copy: by the edge the
          // committed document has grown by this turn's tail, so "-3" would land three messages later
          // than the caller meant. A positive index is already an absolute address, and the turn only
          // appends, so it still points at the message it named.
          const index = msgIndex < 0 ? ctx.session.messages.length + msgIndex : msgIndex;
          defer(() => applyDeferred(store, principal, action, sessionId, index));
          yield { type: 'result', value: {
            deferred: true,
            sessionId,
            message:
              `The ${action} of session "${sessionId}" is queued: it is the session this turn is running in, ` +
              'and the turn owns it until it commits, so the edit is applied once this turn ends. Its ' +
              'outcome cannot be reported here. This turn continues to see the unedited history.',
          } };
          return;
        }

        const outcome = await applyEdit(store, action, sessionId, msgIndex);
        if (!outcome.ok) { yield { type: 'error', message: outcome.message }; return; }
        yield { type: 'result', value: outcome.value };
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
