import type { Session, SessionStatus, Message } from './types.js';

// `createMessage` lives in plugin-api, where the hook registry can also reach it (core is downstream of
// that package). Re-exported here so it stays where every consumer already imports it from.
export { createMessage } from '@matatbread/matbot-plugin-api';

export interface CreateSessionOpts {
  title?:  string;
  /** Defaults to `'active'`. `'archived'` creates it hidden: off the default session list from the
   *  start, rather than created visible and hidden by a second write. */
  status?: SessionStatus;
}

export function createSession(opts: CreateSessionOpts = {}): Session {
  const now = new Date().toISOString();
  return {
    id:               crypto.randomUUID(),
    version:          crypto.randomUUID(),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    status:    opts.status ?? 'active',
    messages:  [],
    createdAt: now,
    updatedAt: now,
  };
}

export function appendMessage(session: Session, message: Message): Session {
  // updatedAt tracks conversational activity: the new last message's timestamp (the lastActivityAt
  // invariant), not a fresh `now()` — so it stays consistent with structural edits that preserve the tail.
  return {
    ...session,
    messages:  [...session.messages, message],
    updatedAt: message.createdAt,
    version:   crypto.randomUUID(),
  };
}

