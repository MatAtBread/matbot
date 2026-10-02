import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolContract, ToolContext, ToolResultOf, Session, Store, Message, SessionRunner,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, lastActivityAt, lastUserIndex } from '@matatbread/matbot-plugin-api';

import { makeCompactSessionsTool } from './compact-sessions.js'
import { compactBefore } from './compaction.js'
import { markerMessage, now } from './marker.js'
import { contentChars, expandSummarised, summariseMessages, summaryMessages, type HandoffSummary } from './summarise.js'

/** An edit of a session a turn is running in (usually the calling one): made by the session's runner once
 *  that turn has written its own document back. The tool cannot report its outcome — awaiting it from
 *  inside the turn it is waiting for is a deadlock — so the result says only that the work is queued. */
interface DeferredEdit { deferred: true; sessionId: string; message: string }

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'session_edit', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    session_edit:
      | ToolContract<{ sessionId: string; messagesRemaining: number } | DeferredEdit,                                                     { action: 'cut';     sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesCopied: number },                                                                    { action: 'fork';    sessionId: string; msgIndex: number }>
      | ToolContract<{ newSessionId: string; messagesSplit: number; currentSessionId: string; messagesRemaining: number } | DeferredEdit, { action: 'split';   sessionId: string; msgIndex: number }>
      | ToolContract<{ sessionId: string; messagesStripped: number } | DeferredEdit,                                                      { action: 'compact'; sessionId: string; msgIndex: number }>
      // Both spellings are one arm, not two: the action is a word a model types from memory, and being
      // told "unknown action" for the American spelling of the only destructive-looking action here is a
      // failure that teaches nothing. `charsAfter` counts the hand-off pair ALONE — the marker holding
      // the originals is elided from every submission, so it is not context the saving has to pay for.
      | ToolContract<{ sessionId: string; messagesSummarised: number; charsBefore: number; charsAfter: number } | DeferredEdit,
                     { action: 'summarise' | 'summarize'; sessionId: string; msgIndex?: number; provider?: string }>;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function bumpVersion<T extends { version: string }>(doc: T): T {
  return { ...doc, version: crypto.randomUUID() };
}

/**
 * The range a `summarise` covers when the caller named no `msgIndex`: the whole session.
 *
 * Which, in the session the calling turn is running in, stops at that turn's own user message — because
 * the request to summarise is not part of the history being summarised. Left unclamped it is: a turn's
 * user message and its tool rounds are already in `ctx.session` by the time a tool runs, so "everything"
 * would sweep in "compact this session" plus the assistant's attempts at it, and those are the freshest
 * thing in the transcript. Measured, not hypothesised — the first real summarise came back describing the
 * compaction rather than the conversation.
 *
 * Another session has no turn in flight, so there everything is everything.
 */
function wholeSessionIndex(session: Session, isCurrentTurn: boolean): number {
  if (!isCurrentTurn) return session.messages.length;
  const userIdx = lastUserIndex(session);
  return userIdx >= 0 ? userIdx : session.messages.length;
}

/**
 * Where an edit applies, named by a message rather than an index. By the time it is made, an index no
 * longer means what it did. A turn does not only append: a parallel reply is placed AHEAD of the running
 * turn's own messages, and shifts everything after it by two. Measured by a message, an edit lands where
 * its caller pointed. A message that has gone by then (popped by a retract, cut by another edit) is a
 * reason not to apply it at all, rather than to apply it at whatever now sits at the old index.
 *
 * Which neighbour of the boundary names it decides where something inserted AT the boundary falls, and
 * the rule is that it stays out of the range the edit removes or rewrites. Nothing that came in after the
 * caller looked is the caller's to delete or summarise. So a cut, which drops `[idx, end)`, names the
 * first message it drops (`before`). Summarise and compact, which rewrite `[0, idx)`, name the last
 * message they cover (`after`). So does split, which moves `[0, idx)` out, and the late arrival stays in
 * the live session. Each falls back to the other neighbour at an end of the session.
 */
type Anchor = { before: string } | { after: string } | { start: true };

function anchorAt(messages: readonly Message[], idx: number, side: 'before' | 'after'): Anchor {
  const first = messages[idx];
  const last  = messages[idx - 1];
  if (side === 'before' && first !== undefined) return { before: first.id };
  if (last !== undefined) return { after: last.id };
  return first !== undefined ? { before: first.id } : { start: true };
}

const anchorSide = (action: IndexAction | 'summarise'): 'before' | 'after' => action === 'cut' ? 'before' : 'after';

function anchoredIndex(session: Session, anchor: Anchor): number | null {
  if ('start' in anchor) return 0;
  const id = 'before' in anchor ? anchor.before : anchor.after;
  const i = session.messages.findIndex(m => m.id === id);
  return i < 0 ? null : 'before' in anchor ? i : i + 1;
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
interface SessionEditInput { action: IndexAction | 'summarise' | 'summarize'; sessionId: string; msgIndex: number; provider?: string }

/** The actions whose whole input is the index they pivot on. `summarise` is the one that needs more
 *  (a provider to summarise with), and the one whose work happens before the edit rather than in it. */
type IndexAction = 'cut' | 'fork' | 'split' | 'compact';

// `conflict` marks a lost compare-and-swap: handed to the runner (`writeEdit`) the edit reads again and
// retries; anywhere else it is reported for the caller to retry.
type EditOutcome =
  | { ok: true;  value: ToolResultOf<'session_edit'> }
  | { ok: false; message: string; conflict?: true };

// Reads the document itself, so it is equally correct called at once or once a turn holding the session
// has ended (the deferred self-edit) — the deferred path must NOT close over a session read before the
// turn committed, which is exactly the state the turn is about to overwrite.
async function applyEdit(store: Store<Session>, action: IndexAction | undefined, sessionId: string, msgIndex: number): Promise<EditOutcome> {
  const session = await store.get(sessionId);
  if (!session) return { ok: false, message: `Session "${sessionId}" not found.` };
  const idx = resolveIndex(session, msgIndex);
  if (idx === null) return { ok: false, message: `msgIndex ${msgIndex} out of range.` };

  switch (action) {
    case 'cut': {
      const trimmed: Session = { ...session, messages: session.messages.slice(0, idx) };
      const next: Session = bumpVersion({ ...trimmed, updatedAt: lastActivityAt(trimmed) });
      const res = await store.cas(sessionId, session.version, next);
      if (!res.ok) return { ok: false, message: 'Concurrent modification — please retry.', conflict: true };
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
        return { ok: false, message: 'Concurrent modification — please retry.', conflict: true };
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
      if (!res.ok) return { ok: false, message: 'Concurrent modification — please retry.', conflict: true };
      return { ok: true, value: { sessionId, messagesStripped: stripped } };
    }

    default:
      return { ok: false, message: `Unknown action "${String(action)}". Expected one of: cut, fork, split, compact.` };
  }
}

// One attempt at an index edit, at the message the caller named (see `Anchor`), in the session as it is
// when the edit is made. A lost compare-and-swap comes back as a `conflict`, to be read again and retried.
function anchoredEdit(store: Store<Session>, action: IndexAction, sessionId: string, anchor: Anchor): () => Promise<EditOutcome> {
  return async () => {
    const session = await store.get(sessionId);
    if (session === null) return { ok: false, message: `Session "${sessionId}" not found.` };
    const idx = anchoredIndex(session, anchor);
    if (idx === null) return { ok: false, message: 'the message it named is no longer in the session.' };
    return applyEdit(store, action, sessionId, idx);
  };
}

/**
 * Hand an edit of `sessionId` to the runner that owns the session (`SessionRunner.write`), which makes it
 * once no turn holds the session. `apply` makes one attempt against the session as it then is, and a
 * `conflict` is read again and retried.
 *
 * When no turn holds the session the edit is made now and its outcome returned. When one does, the result
 * is `'deferred'`: that turn may be the caller's own, which the edit is waiting for, so a failure is logged
 * instead, there being nobody left to tell. `apply` is told which, for an edit whose rules differ.
 */
async function writeEdit(
  run: SessionRunner | undefined, sessionId: string, what: string, apply: (deferred: boolean) => Promise<EditOutcome>,
): Promise<EditOutcome | 'deferred'> {
  if (run === undefined) return apply(false);
  let deferred = false;
  let outcome: EditOutcome = { ok: false, message: `The ${what} failed (see the log).` };
  const write = run.write(sessionId, async () => {
    outcome = await apply(deferred);
    if (!outcome.ok && outcome.conflict === true) return false;
    if (deferred && !outcome.ok) console.error(`[session_edit] deferred ${what} of session "${sessionId}" not applied: ${outcome.message}`);
    return true;
  }, `[session_edit] ${what} of session "${sessionId}" lost to repeated concurrent writes.`);
  // Read by `apply`, which never runs before `write` returns.
  deferred = write.deferred;
  if (deferred) return 'deferred';
  await write.done;
  return outcome;
}

/**
 * Splice a prepared hand-off summary in place of `messages[0..msgIndex)`.
 *
 * Reads the document itself, like {@link applyEdit}, so it is equally correct at once or deferred — and
 * it re-derives the originals it stashes from what it reads, rather than from the copy the summary was
 * written against. Deferred, the range is re-found by its anchor (see `Anchor`), so it is the history the
 * summary was written from, plus any parallel reply placed into it meanwhile. Made at once,
 * `expectVersion` is the version the summary was built from, which turns a concurrent write during the
 * (slow) LLM call into a reportable CAS failure instead of a silent overwrite.
 */
async function applySummary(
  store: Store<Session>, sessionId: string, idx: number, summary: HandoffSummary, expectVersion?: string,
): Promise<EditOutcome> {
  const session = await store.get(sessionId);
  if (!session) return { ok: false, message: `Session "${sessionId}" not found.` };
  // Takes an already-resolved absolute index, not a raw `msgIndex`: the caller resolved it against the
  // copy it built the summary from, and `resolveIndex` is the wrong gate anyway — it rejects
  // `messages.length`, which for a range of `[0, idx)` is the legitimate "summarise all of it".
  if (idx <= 0 || idx > session.messages.length) return { ok: false, message: `Nothing to summarise in range [0, ${idx}).` };

  const originals = expandSummarised(session.messages.slice(0, idx));
  const replacement = summaryMessages(summary, originals);
  const summarised: Session = { ...session, messages: [...replacement, ...session.messages.slice(idx)] };
  const next: Session = bumpVersion({ ...summarised, updatedAt: lastActivityAt(summarised) });
  const res = await store.cas(sessionId, expectVersion ?? session.version, next);
  if (!res.ok) return { ok: false, message: 'Concurrent modification — please retry.', conflict: true };
  return { ok: true, value: {
    sessionId,
    messagesSummarised: idx,
    charsBefore:        contentChars(originals),
    // The marker is dropped from the count deliberately — see the contract arm.
    charsAfter:         contentChars(replacement.slice(1)),
  } };
}

function makeSessionEditTool(store: Store<Session>, services: MatbotMachine): Tool<ToolResultOf<'session_edit'>> {
  const ownership = (isCurrentTurn: boolean): string => isCurrentTurn
    ? 'it is the session this turn is running in, and the turn owns it until it commits'
    : 'a turn is running in it, and that turn owns it until it commits';
  const unedited = (isCurrentTurn: boolean): string => isCurrentTurn ? ' This turn continues to see the unedited history.' : '';

  return {
    name: 'session_edit',
    description:
      'Edit the message history of a session (see `session_action` for what a session is). Every ' +
      'action takes a session ID and a message index (`msgIndex`, an index into session.messages) ' +
      'and uses it to manage the conversation\'s length and structure — except `summarise`, for which ' +
      'omitting `msgIndex` means the whole session:\n' +
      '  cut     — Truncate: remove all messages from msgIndex onward.\n' +
      '  fork    — Branch: create a NEW session with messages[0..msgIndex-1]; the original is unchanged.\n' +
      '  split   — Move: messages before msgIndex move to a new session; the current session keeps\n' +
      '            msgIndex onward. Both sides get cross-link markers.\n' +
      '  compact — Shrink: strip thinking blocks, tool calls, and tool results from messages before\n' +
      '            msgIndex, keeping user/assistant text — fewer tokens, same thread. A message left\n' +
      '            with no content is removed, so earlier indices shift; re-read the session before\n' +
      '            using a msgIndex you read from it beforehand.\n' +
      '  summarise — Shrink by MEANING rather than by shape: an LLM rewrites messages[0..msgIndex-1]\n' +
      '            as a two-part hand-off document — a user message carrying what was wanted (an\n' +
      '            objective and its standing constraints, or, for a conversation that ranged over\n' +
      '            topics, the list of them), and an assistant message carrying what is known now:\n' +
      '            the ANSWERS, decisions and their reasons, outcomes, identifiers to reuse, and\n' +
      '            what is still open. What it drops is the bulk those came from — listings, search\n' +
      '            results, file bodies, pages of tool output — and the discussion behind a\n' +
      '            decision, which is what compact keeps. Costs one LLM call on `provider` (default:\n' +
      '            this turn\'s). The replaced messages are NOT destroyed: they move into a marker you\n' +
      '            never see, which a later summarise re-reads — so history is never summarised twice,\n' +
      '            and the session document does not shrink on disk (use cut to actually discard).\n' +
      '            OMIT msgIndex to summarise the whole session — which is what you usually want, and\n' +
      '            what to do when asked to summarise or compact "this session". In the session you\n' +
      '            are running in, the whole session ends where THIS turn began: the request you are\n' +
      '            answering is not part of the history it is about, so it is never summarised.\n' +
      '            Reach for it when a long thread has to keep going and compact is too blunt; the\n' +
      '            result reports charsBefore/charsAfter so you can see what it bought. A REPEAT\n' +
      '            summarise reads the expanded original history, which can be larger than the\n' +
      '            conversation you can see — if the call fails for want of context, name a bigger\n' +
      '            `provider`; a failed summarise changes nothing, so retrying costs only the call.\n' +
      'Cutting, splitting, compacting or summarising a session with a turn running in it — the current turn, or ' +
      'another session\'s — is DEFERRED: the turn owns that document until it commits, so the edit is queued ' +
      'and applied once the turn ends. The ' +
      'result says `deferred: true` and carries no counts — they are not knowable yet. Do not re-issue it, ' +
      'and do not read the session back this turn to check: it still holds the pre-edit history. `fork` is ' +
      'immediate on any session (it only writes a new document), but forks the committed state, without ' +
      'this turn\'s uncommitted tail.',
    inputSchema: {
      type:       'object',
      required:   ['action', 'sessionId'],
      properties: {
        action:    { type: 'string', enum: ['cut', 'fork', 'split', 'compact', 'summarise', 'summarize'], description: 'The edit to perform.' },
        sessionId: { type: 'string', description: 'ID of the session to edit.' },
        provider:  { type: 'string', description: 'summarise only (optional): provider key to write the summary with. Defaults to the provider of the current turn.' },
        msgIndex:  { type: 'number', description: 'Index into session.messages the action pivots on (see per-action meaning in the description). Like slice index, negative is an offset from the end of the session. Required by cut/fork/split/compact; OMIT it for summarise to mean the whole session.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const { action, sessionId, msgIndex } = input as Partial<SessionEditInput>;
        if (!sessionId) { yield { type: 'error', message: 'session_edit requires "sessionId".' }; return; }
        // A background job's store is its parent's medium, written by none of the parent's turns: an edit
        // from here would land under one of them unseen and be undone by its write-back. `fork` is the
        // exception — it writes a session no turn can yet be running in.
        if (services.isSubAgent() && action !== 'fork') {
          yield { type: 'error', message: `A background job cannot ${String(action)} a session — it would race the turns of the process that owns it. Only "fork" is available here.` };
          return;
        }

        // Summarise runs its LLM call BEFORE any mutation, so a provider failure or a malformed summary
        // leaves the session exactly as it was and is reported here — the one thing the deferred path
        // cannot do (see the deferred result below).
        if (action === 'summarise' || action === 'summarize') {
          const provider = (input as Partial<SessionEditInput>).provider ?? ctx.provider;
          if (provider === undefined) {
            yield { type: 'error', message: 'summarise needs a "provider" — none was given and there is no current turn provider to fall back to.' };
            return;
          }
          // The running turn's own session is read from ctx.session: its committed document does not yet
          // hold this turn. The prefix being summarised is the same history in both, give or take a
          // parallel reply placed into the turn, which is why the deferred write re-finds it by anchor.
          const isCurrentTurn = sessionId === ctx.session.id;
          const source = isCurrentTurn ? ctx.session : await store.get(sessionId);
          if (!source) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
          // No msgIndex means the whole session — see wholeSessionIndex. A named one is resolved as it is
          // everywhere else (negative counts from the end), except that `messages.length` is allowed:
          // the range is `[0, idx)`, so the end of the array is "all of it" rather than out of bounds.
          const idx = msgIndex === undefined
            ? wholeSessionIndex(source, isCurrentTurn)
            : (msgIndex < 0 ? source.messages.length + msgIndex : msgIndex);
          if (idx <= 0 || idx > source.messages.length) {
            yield { type: 'error', message: `Nothing to summarise in range [0, ${idx}) of ${source.messages.length} message(s).` };
            return;
          }

          let summary: HandoffSummary;
          try {
            summary = await summariseMessages(services, provider, expandSummarised(source.messages.slice(0, idx)), ctx.signal);
          } catch (e) { yield { type: 'error', message: e instanceof Error ? e.message : String(e) }; return; }

          // Made now, of another session, the replacement is checked against the version the summary was
          // written from: the LLM call is slow enough that a concurrent write is a real possibility, and
          // summarising over one would discard it silently, so a conflict is reported rather than retried.
          // Deferred, the waiting turn has grown the session since, so the range is re-found by its anchor
          // instead — and so it is for this turn's own session however it is made, since what the summary
          // was written from is the turn's copy (or a parallel turn's), whose version and indices are not
          // the stored document's.
          const anchor = anchorAt(source.messages, idx, anchorSide('summarise'));
          const outcome = await writeEdit(services.run, sessionId, 'summarise', async deferred => {
            if (!deferred && !isCurrentTurn) {
              const made = await applySummary(store, sessionId, idx, summary, source.version);
              return made.ok ? made : { ok: false, message: made.message };
            }
            const session = await store.get(sessionId);
            const at = session !== null ? anchoredIndex(session, anchor) : null;
            if (at === null) return { ok: false, message: 'the message it ended at is no longer in the session.' };
            return applySummary(store, sessionId, at, summary);
          });
          if (outcome === 'deferred') {
            yield { type: 'result', value: {
              deferred: true,
              sessionId,
              message:
                `The summary of session "${sessionId}" is written, and replacing the ${idx} message(s) it covers ` +
                `is queued: ${ownership(isCurrentTurn)}. Its outcome cannot be reported here.${unedited(isCurrentTurn)}`,
            } };
            return;
          }
          if (!outcome.ok) { yield { type: 'error', message: outcome.message }; return; }
          yield { type: 'result', value: outcome.value };
          return;
        }

        // A running turn owns its session document: the runner takes one in-memory copy at turn start
        // and writes it back unconditionally at turn end, so a write landing here is overwritten seconds
        // later — silently, since that write is not a CAS. That holds for whichever turn it is, this one
        // or another session's. So the edit is the runner's to make (`writeEdit`), once that turn's
        // write-back has happened, and it reads the committed document.
        // The outcome cannot then be reported: awaiting it from inside this turn would deadlock. The result
        // says "queued" and nothing more. `fork` is exempt — it only writes a new document.
        const isCurrentTurn = sessionId === ctx.session.id;
        if (action === 'cut' || action === 'split' || action === 'compact') {
          if (typeof msgIndex !== 'number') { yield { type: 'error', message: `session_edit "${action}" requires "msgIndex" (number). Only "summarise" may omit it.` }; return; }
          // Resolve the index NOW, against the history the caller can see, to the message it names (see
          // `Anchor`). That is this turn's own copy, or for another session its committed document. If a
          // turn holds the session, its document has grown by that turn's tail by the time the edit is made,
          // so "-3" would land three messages later than the caller meant, and a parallel reply placed
          // ahead of the turn shifts even a positive index.
          const visible = isCurrentTurn ? ctx.session : await store.get(sessionId);
          if (!visible) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
          const index = resolveIndex(visible, msgIndex);
          if (index === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }
          const outcome = await writeEdit(services.run, sessionId, action, anchoredEdit(store, action, sessionId, anchorAt(visible.messages, index, anchorSide(action))));
          if (outcome !== 'deferred') {
            if (!outcome.ok) { yield { type: 'error', message: outcome.message }; return; }
            yield { type: 'result', value: outcome.value };
            return;
          }
          yield { type: 'result', value: {
            deferred: true,
            sessionId,
            message:
              `The ${action} of session "${sessionId}" is queued: ${ownership(isCurrentTurn)}, so the edit is ` +
              `applied once that turn ends. Its outcome cannot be reported here.${unedited(isCurrentTurn)}`,
          } };
          return;
        }

        if (typeof msgIndex !== 'number') { yield { type: 'error', message: `session_edit "${String(action)}" requires "msgIndex" (number). Only "summarise" may omit it.` }; return; }
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
    services.tools.register(makeSessionEditTool(store, services));
    // Bulk compaction rewrites other sessions wholesale; from a background job that is a write racing
    // every turn of the process that owns them, with nothing a refusal per session would save.
    if (!services.isSubAgent()) services.tools.register(makeCompactSessionsTool(store, () => services.run));
  },
};
