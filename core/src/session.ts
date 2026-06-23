import type { Session, Message, MessageContent, MessageRole, Principal } from './types.js';

export interface CreateSessionOpts {
  ownerPrincipal:        Principal;
  actorPrincipal?:       Principal;
  persona?:              string;
  title?:                string;
  contexts?:             string[];
  parentSessionId?:      string;
  branchPointMessageId?: string;
}

export function createSession(opts: CreateSessionOpts): Session {
  const now = new Date().toISOString();
  return {
    id:               crypto.randomUUID(),
    version:          crypto.randomUUID(),
    ownerPrincipalId: opts.ownerPrincipal.id,
    ...(opts.actorPrincipal && opts.actorPrincipal.id !== opts.ownerPrincipal.id
      ? { actorPrincipalId: opts.actorPrincipal.id }
      : {}),
    ...(opts.persona              !== undefined ? { persona:              opts.persona              } : {}),
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
  return {
    ...session,
    messages:  [...session.messages, message],
    updatedAt: new Date().toISOString(),
    version:   crypto.randomUUID(),
  };
}

export function createMessage(opts: {
  role:           MessageRole;
  content:        MessageContent[];
  traceId:        string;
  providerName?:  string;
  metadata?:      Record<string, unknown>;
}): Message {
  return {
    id:        crypto.randomUUID(),
    role:      opts.role,
    content:   opts.content,
    createdAt: new Date().toISOString(),
    traceId:   opts.traceId,
    ...(opts.providerName !== undefined ? { providerName: opts.providerName } : {}),
    ...(opts.metadata     !== undefined ? { metadata:     opts.metadata     } : {}),
  };
}
