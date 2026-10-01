import type { AppendMessage, AppendResult, Notifier, Session, SessionAppender, Store } from './types.js';
import { onContextQuiesce, runAs, tryCurrentPrincipal, SessionAppendKind } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from './session.js';

// A conflict means another writer landed between this edge flusher's read and its write — at the edge
// that is another flusher, never a turn. An append composes with any of them, so it re-reads and goes
// again rather than giving up; the bound only stops a pathological loop.
const APPEND_ATTEMPTS = 3;

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

      // The edge runs outside every principal scope, and the store is ownership-checked: restore the
      // caller's, exactly as the deferred session edits do.
      const write = async (): Promise<void> => {
        for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
          const current = await store.get(sessionId);
          if (current === null) {
            console.error(`[matbot] append to session "${sessionId}" dropped: the session no longer exists.`);
            return;
          }
          if ((await store.cas(sessionId, current.version, built.reduce(appendMessage, current))).ok) {
            deps.notifier().notify({
              kind: SessionAppendKind, source: 'append', sessionId, messageIds,
              ...(principal !== undefined ? { principal } : {}),
            });
            return;
          }
        }
        console.error(`[matbot] append to session "${sessionId}" lost to repeated concurrent writes.`);
      };
      onContextQuiesce(un => {
        un();
        // Returned, not detached: the edge holds back the next turn's read of this session until it lands.
        return principal !== undefined ? runAs(principal, write) : write();
      });
      return { sessionId, messageIds };
    },
  };
}
