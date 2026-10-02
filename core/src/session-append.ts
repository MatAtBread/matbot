import type { AppendMessage, AppendResult, Notifier, Session, SessionAppender, Store } from './types.js';
import { tryCurrentPrincipal, isReadOnlyError, SessionAppendKind } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from './session.js';
import { casAtEdge } from './cas-at-edge.js';

/**
 * The host's {@link SessionAppender}: an append is checked now and written at the quiescent edge.
 *
 * Checked now so that a session that does not exist is reported to a caller who can still act on it;
 * written at the edge because that is the one moment no turn holds a copy of any session that its
 * write-back would put over this. Seeded in every process, and refuses in a background job — whose
 * store is the parent's medium with none of the parent's pumps behind it — until the job registers one
 * that forwards to its parent.
 */
export function createSessionAppender(deps: {
  sessions:   () => Store<Session> | undefined;
  notifier:   () => Notifier;
  isSubAgent: () => boolean;
}): SessionAppender {
  return {
    async append(sessionId, messages): Promise<AppendResult> {
      if (deps.isSubAgent()) {
        throw new Error('This background job has no way to reach its parent\'s sessions, so it cannot append to one.');
      }
      if (sessionId === undefined) throw new Error('No session was named to append to.');
      if (messages.length === 0) throw new Error('Nothing to append.');
      const store = deps.sessions();
      if (store === undefined) throw new Error('No session store is available.');
      if (await store.get(sessionId) === null) throw new Error(`Session "${sessionId}" not found.`);

      const principal = tryCurrentPrincipal();
      const traceId   = crypto.randomUUID();
      const built     = messages.map((m: AppendMessage) => createMessage({
        role: m.role, content: m.content, traceId,
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      }));
      const messageIds = built.map(m => m.id);

      casAtEdge(async () => {
        const current = await store.get(sessionId);
        if (current === null) {
          console.error(`[matbot] append to session "${sessionId}" dropped: the session no longer exists.`);
          return true;
        }
        try {
          if (!(await store.cas(sessionId, current.version, built.reduce(appendMessage, current))).ok) return false;
        } catch (e) {
          // Readable, so accepted; not writable — a session shared in read-only. The caller was told it was
          // accepted, so the log must say what was lost, which the edge's generic "flush rejected" did not.
          if (!isReadOnlyError(e)) throw e;
          console.error(`[matbot] append to session "${sessionId}" dropped: ${e.message}`);
          return true;
        }
        deps.notifier().notify({
          kind: SessionAppendKind, source: 'append', sessionId, messageIds,
          ...(principal !== undefined ? { principal } : {}),
        });
        return true;
      }, `[matbot] append to session "${sessionId}" lost to repeated concurrent writes.`);
      return { sessionId, messageIds };
    },
  };
}
