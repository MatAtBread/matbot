import type { Session, Message, MessageContent, MessageRole, Usage } from './types.js';

export interface CreateSessionOpts {
  title?:                string;
  contexts?:             string[];
  parentSessionId?:      string;
  branchPointMessageId?: string;
}

export function createSession(opts: CreateSessionOpts = {}): Session {
  const now = new Date().toISOString();
  return {
    id:               crypto.randomUUID(),
    version:          crypto.randomUUID(),
    ...(opts.title                !== undefined ? { title:                opts.title                } : {}),
    ...(opts.parentSessionId      !== undefined ? { parentSessionId:      opts.parentSessionId      } : {}),
    ...(opts.branchPointMessageId !== undefined ? { branchPointMessageId: opts.branchPointMessageId } : {}),
    status:    'active',
    contexts:  opts.contexts ?? [],
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

export function createMessage(opts: {
  role:           MessageRole;
  content:        MessageContent[];
  traceId:        string;
  providerName?:  string;
  usage?:         Usage;
  metadata?:      Record<string, unknown>;
}): Message {
  return {
    id:        crypto.randomUUID(),
    role:      opts.role,
    content:   opts.content,
    createdAt: new Date().toISOString(),
    traceId:   opts.traceId,
    ...(opts.providerName !== undefined ? { providerName: opts.providerName } : {}),
    ...(opts.usage        !== undefined ? { usage:        opts.usage        } : {}),
    ...(opts.metadata     !== undefined ? { metadata:     opts.metadata     } : {}),
  };
}
