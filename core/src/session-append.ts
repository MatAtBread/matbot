import type { AppendMessage, AppendResult, Notifier, Session, SessionAppender, SessionRunner, Store } from './types.js';
import { tryCurrentPrincipal, isReadOnlyError, SessionAppendKind } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from './session.js';

/**
 * The host's {@link SessionAppender}: an append is checked now, and written by the session's runner once no
 * turn holds the session (`SessionRunner.write`).
 *
 * Checked now so that a session that does not exist is reported to a caller who can still act on it. When
 * no turn holds the session the write runs at once and the append settles once it has, so a write that
 * cannot land (the session went, or it is shared in read-only) is reported too. When a turn holds it, the
 * append settles on acceptance: the caller may be that very turn, which the write is waiting for.
 *
 * Seeded in every process, and refuses in a background job — whose store is the parent's medium with none
 * of the parent's turns behind it — until the job registers one that forwards to its parent.
 */
export function createSessionAppender(deps: {
  sessions:   () => Store<Session> | undefined;
  run:        () => SessionRunner | undefined;
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
      const run = deps.run();
      if (run === undefined) throw new Error('No session runner is available to write the session.');
      if (await store.get(sessionId) === null) throw new Error(`Session "${sessionId}" not found.`);

      const principal = tryCurrentPrincipal();
      const traceId   = crypto.randomUUID();
      const built     = messages.map((m: AppendMessage) => createMessage({
        role: m.role, content: m.content, traceId,
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      }));
      const messageIds = built.map(m => m.id);

      let landed = false;
      let dropped: string | undefined;
      const write = run.write(sessionId, async () => {
        const current = await store.get(sessionId);
        if (current === null) {
          dropped = `Session "${sessionId}" no longer exists.`;
          console.error(`[matbot] append to session "${sessionId}" dropped: the session no longer exists.`);
          return true;
        }
        try {
          if (!(await store.cas(sessionId, current.version, built.reduce(appendMessage, current))).ok) return false;
        } catch (e) {
          // Readable, so accepted; not writable — a session shared in read-only.
          if (!isReadOnlyError(e)) throw e;
          dropped = e.message;
          console.error(`[matbot] append to session "${sessionId}" dropped: ${e.message}`);
          return true;
        }
        deps.notifier().notify({
          kind: SessionAppendKind, source: 'append', sessionId, messageIds,
          ...(principal !== undefined ? { principal } : {}),
        });
        landed = true;
        return true;
      }, `[matbot] append to session "${sessionId}" lost to repeated concurrent writes.`);

      if (!write.deferred) {
        await write.done;
        if (!landed) throw new Error(`The append was not written: ${dropped ?? 'it failed, or lost to repeated concurrent writes (see the log).'}`);
      }
      return { sessionId, messageIds, ...(write.deferred ? { deferred: true as const } : {}) };
    },
  };
}
