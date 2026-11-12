import type { Message, MessageContent, MessageRole, Session } from './types.js';

/**
 * A `Message` with the fields every one carries minted for it — a fresh id, `createdAt` now — and the
 * optional ones spread conditionally.
 *
 * Lives here rather than in core because a message is not core's to define: the hook registry builds
 * marker messages in *this* package, and had its own copy of these five lines because core is
 * downstream of it. There were five such copies in two packages, and every one of them is a place a
 * message could quietly acquire a different shape.
 */
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

/**
 * A session's `updatedAt` invariant: the timestamp of its last message, or its own `createdAt` when it
 * has none. `updatedAt` tracks *conversational activity*, not structural or metadata edits — so a
 * compaction, cut, split, fork, rename, or archive leaves it (and thus the session's place in a
 * recency-sorted list) untouched, since none of them change which message is last. Kept as a
 * materialised field, not a getter: `Session` round-trips as plain JSON through every storage backend
 * and is sorted on `updatedAt` as a stored column, neither of which survives a live accessor.
 *
 * Apply it to the final session object at every write — `{ ...session, updatedAt: lastActivityAt(session) }`
 * — rather than stamping a fresh `now()`.
 */
export function lastActivityAt(session: Session): string {
  const last = session.messages[session.messages.length - 1];
  return last ? last.createdAt : session.createdAt;
}

/**
 * The `Message.metadata` key marking a user message as a **robo-submit**: machine-authored (its blocks are
 * `origin: 'robo'`) and still a request in its own right, which the conversation answers as a turn — a
 * background job asking about what it found. Set by the host when a `SessionAppender` is handed a user
 * message, never by the author.
 *
 * It exists because `origin: 'robo'` alone has always meant two things: who wrote a message, and that it is
 * not a new request — a `followup` resubmit, which continues the turn before it. A robo-submit is the first
 * message that is one and not the other.
 */
export const ROBO_SUBMIT = 'roboSubmit';

/** What a robo-submit's mark holds: who sent it, in words a model is shown (`background job "x"`). */
export interface RoboSubmitMark { from?: string }

/** Whether `message` is a robo-submit (see {@link ROBO_SUBMIT}). */
export function isRoboSubmit(message: Message): boolean {
  const mark = message.role === 'user' ? message.metadata?.[ROBO_SUBMIT] : undefined;
  return mark === true || (typeof mark === 'object' && mark !== null);
}

/**
 * `message` as a model is shown it: a robo-submit says who sent it, since nothing else on the wire does —
 * `origin` and metadata are not sent — and a model told nothing answers a job's question as the person's.
 * For the outgoing copy only, never stored; fixed per message, so it costs no prompt cache.
 */
export function withSenderShown(message: Message): Message {
  if (!isRoboSubmit(message)) return message;
  const mark = message.metadata?.[ROBO_SUBMIT] as RoboSubmitMark | true;
  const from = mark !== true && typeof mark.from === 'string' && mark.from !== '' ? mark.from : 'an automated process';
  return { ...message, content: [{ type: 'text', text: `[Sent by ${from}, not by the person in this conversation.]` }, ...message.content] };
}

/**
 * Whether `message` is a request — a user message that starts a piece of work, rather than one continuing
 * the work before it (a `followup` resubmit, which is wholly `origin: 'robo'`). A person's message is one,
 * and so is a robo-submit.
 */
export function isRequest(message: Message): boolean {
  return message.role === 'user' && (!message.content.every(c => c.origin === 'robo') || isRoboSubmit(message));
}

/**
 * Index of the turn's user message — the message a durable fold attaches to, and the point a retraction
 * pops back to. `-1` when the session has none.
 */
export function lastUserIndex(session: Session): number {
  return session.messages.findLastIndex(m => m.role === 'user');
}

/**
 * Append `blocks` to the turn's user message, returning a new session. This is what "durable" means
 * everywhere it appears: unlike `ephemeral` (tail-folded into the outgoing copy and discarded), the blocks
 * become part of the user turn — persisted, visible to a reader, and carried by every subsequent provider
 * call in the turn and after it.
 *
 * With no user message the blocks are **dropped rather than orphaned**: there is nothing they could belong
 * to, and appending a message of their own would change the role sequence the adapters depend on.
 *
 * Shared because the three callers must agree: the `screen` hook fold, the runner's raced-verdict
 * correction, and the pump's retract-and-rerun rebase. They were three independent copies of one
 * `findLastIndex` + splice, in two different packages.
 */
export function foldOntoUserTurn(session: Session, blocks: readonly MessageContent[]): Session {
  if (blocks.length === 0) return session;
  const idx = lastUserIndex(session);
  if (idx < 0) return session;
  return { ...session, messages: session.messages.map((m, i) =>
    i === idx ? { ...m, content: [...m.content, ...blocks] } : m) };
}

/** The creator of the marker a sub-turn's transcript starts with (`single_turn` with `tools: true`). */
export const SUB_TURN_CREATOR = 'matbot-sub-turn';

/**
 * How many turns deep these messages are: 0 for a conversation, 1 for a turn another turn started, and so
 * on. Read off a marker in the transcript because `ctx.session` is the one thing every door hands a tool or
 * a hook and a body cannot replace, so nothing has to remember to forward it.
 *
 * Here rather than in core because a hook needs it too: a sub-turn has no person on either end (its prompt
 * is another model's, and its answer goes back to that model), so a hook that judges what a person said, or
 * what was said back to them, has nothing to judge in one.
 */
export function subTurnDepth(messages: readonly Message[]): number {
  let depth = 0;
  for (const m of messages) {
    if (m.role !== 'marker') continue;
    for (const c of m.content) {
      if (c.type === 'marker' && c.creator === SUB_TURN_CREATOR) depth = Math.max(depth, (c.data as { depth: number }).depth);
    }
  }
  return depth;
}
