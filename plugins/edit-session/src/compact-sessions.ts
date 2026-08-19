/**
 * `compact_sessions` tool: apply the "Compact sessions" compaction policy to the session store.
 *
 * Compiled from the markdown skill of the same name. Two-tier policy, fully deterministic — no LLM
 * decisions:
 *
 *   Tier 1 — Full compact (msgIndex = -1):
 *     Any session that is `status === "archived"` OR whose `updatedAt` is more than 28 days old.
 *     Strips all tool calls, tool results, and thinking blocks from every message in the session.
 *
 *   Tier 2 — Partial compact (msgIndex = -10):
 *     Any session with >20 messages that did NOT qualify for Tier 1.
 *     Strips tool calls / tool results / thinking blocks from all messages EXCEPT the last 10.
 *
 * What compaction *means* — which blocks survive, and that a message left with none is removed — is
 * `compactBefore` in ./compaction.ts, shared with the `session_edit` `compact` action. This file owns
 * only the policy: which sessions, and where each one's cutoff falls.
 *
 * The current session (ctx.session.id) is deferred to the quiescent edge rather than compacted in
 * place: the running turn owns that document until it commits. Idempotent: a session whose content has
 * already been stripped yields 0 messagesStripped and no error.
 *
 * A sweep spans a whole store, so it meets sessions it cannot write — one shared in read-only from
 * another profile. That is a condition, not a fault: it is reported per session under `skipped` and the
 * sweep continues. Every other failure aborts, deliberately — a sweep that met a broken backend and
 * still reported a tidy summary would be worse than one that raised.
 *
 * Invoke via background tool or call directly as a tool.
 */

import type { Tool, ToolExecutor, ToolContract, ToolContext, ToolResultOf, Session, Store } from '@matatbread/matbot-plugin-api';
import { lastActivityAt, currentPrincipal, runAs, isReadOnlyError } from '@matatbread/matbot-plugin-api';

import { compactBefore } from './compaction.js'
import { defer } from './defer.js'

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    compact_sessions: ToolContract<
      {
        examined:  number;
        pages:     number;
        compacted: Array<{ sessionId: string; title: string; tier: 'full' | 'partial'; messagesStripped: number }>;
        /** `kind` separates "nothing to do" from the two failures a caller must treat differently —
         *  `denied` (never going to work, it isn't yours) vs `unavailable` (try later). `reason` is the
         *  human-readable detail; branch on `kind`, never on the prose. */
        skipped:   Array<{ sessionId: string; title: string; kind: SkipKind; reason: string }>;
        /** The calling turn's own session, whose compaction was queued for after this turn commits.
         *  No tier and no count: both are decided when it is applied, and reporting them would mean
         *  waiting for an edge this turn has to end to reach. */
        deferred:  Array<{ sessionId: string; title: string }>;
      },
      { inactiveDays?: number; activeMessages?: number }
    >;
  }
}

interface CompactSessionsParams {
  inactiveDays?: number;   // Threshold for full compact. Default 28
  activeMessages?: number; // Number of messages at the end of the session to NOT compact. Default 10
}

/**
 * Why a session was not compacted, in the one dimension a caller can act on — the 4xx/5xx distinction.
 * `reason` is prose for a human; `kind` is for whoever has to decide what to do next, and must not be
 * inferred by matching on the prose.
 *
 *   `ineligible`  — nothing to do, and nothing wrong. The policy examined it and declined.
 *   `denied`      — refused, and asking again will be refused again (a session owned by someone else).
 *   `unavailable` — could not be completed now; the same call later may well succeed.
 *
 * The two failure classes are genuinely different remedies, which is why one string covering both was
 * wrong: `denied` means stop and go to the owner, `unavailable` means come back.
 */
export type SkipKind = 'ineligible' | 'denied' | 'unavailable';

type CompactOutcome =
  | { done: true;  tier: 'full' | 'partial'; stripped: number }
  | { done: false; kind: SkipKind; reason: string };

// The whole per-session policy — tier decision included — behind one re-read, so it is equally
// correct run inline during the scan or later from the quiescent edge (the current session's deferred
// compaction). The deferred path MUST decide against the document as it will then be, not as the scan
// saw it: by the edge the session has grown by the turn that called this tool.
async function compactOne(
  store:      Store<Session>,
  sessionId:  string,
  opts:       Required<CompactSessionsParams>,
  inactiveMs: number,
): Promise<CompactOutcome> {
  // Re-read via get() so the CAS below uses a fresh version — a query result may be stale
  const current = await store.get(sessionId);
  if (!current) return { done: false, kind: 'ineligible', reason: 'deleted before it could be compacted' };

  const tier: 'full' | 'partial' | undefined =
    current.status === 'archived' || Date.now() - new Date(current.updatedAt).getTime() >= inactiveMs ? 'full'
    : current.messages.length > opts.activeMessages * 2                                               ? 'partial'
    : undefined;
  if (tier === undefined) return { done: false, kind: 'ineligible', reason: 'below thresholds' };

  // A negative msgIndex ("keep the last N") is what makes the deferred path self-correcting: it is
  // resolved against the document at apply time, so the turn's own tail is among the messages kept.
  const { messages, stripped } = compactBefore(current.messages, tier === 'full' ? -1 : -opts.activeMessages);
  if (stripped === 0) return { done: false, kind: 'ineligible', reason: 'nothing left to strip — already compacted' };

  const next: Session = { ...current, messages, updatedAt: lastActivityAt({ ...current, messages }) };
  try {
    const res = await store.cas(current.id, current.version, { ...next, version: crypto.randomUUID() });
    // ONE attempt per session, deliberately. Two things reach a lost CAS here, and neither is answered by
    // trying again from inside the sweep:
    //
    //   A concurrent writer — answered by the next scheduled run instead. Compaction is idempotent and this
    //   tool is a scheduled whole-store pass, so a session skipped now is compacted on the next one; the
    //   only thing a retry buys is latency, paid for by doubling the reads of a sweep over every session.
    //
    //   A StorageBackend swap, which `mediumGuard` reports AS this loss with "re-read and retry" — advice
    //   that cannot be taken here. A swap is deferred to the quiescent edge, and under the pump (a tool
    //   call inside a turn) the machine is held across the whole queue, so the edge is unreachable until
    //   this turn ends: the retry would re-read the same medium and lose again, and sleeping first only
    //   holds open the very turn the edge is waiting for. The retry belongs at the edge, where the swap
    //   has actually landed — which is a layer above this one, not a loop inside it.
    if (!res.ok) return { done: false, kind: 'unavailable',
      reason: 'the session changed while it was being written (a concurrent edit, or the storage backend was swapped) — a later run will pick it up' };
    return { done: true, tier, stripped };
  } catch (e) {
    // A partitioned store holds sessions this principal may read and may not write — a share. Asking
    // first would couple this policy to one backend's optional ownership capability and still race a
    // share landing before the write, so the write stays the authority and its refusal — per-operation
    // by contract, not a process fault — becomes this session's skip reason. Deliberately just the one
    // branded error: a real fault must still abort the sweep, or the tool reports a pass it never made.
    if (!isReadOnlyError(e)) throw e;
    return { done: false, kind: 'denied',
      reason: `owned by "${e.owner || 'global'}" and shared in read-only — only its owner can compact it` };
  }
}

// ── tool factory ──────────────────────────────────────────────────────────────

const compactSessionDefaults: Required<CompactSessionsParams> = { activeMessages: 10, inactiveDays: 28 };
export function makeCompactSessionsTool(store: Store<Session>): Tool<ToolResultOf<'compact_sessions'>> {
  const executor: ToolExecutor<ToolResultOf<'compact_sessions'>> = {
    async *execute(input: CompactSessionsParams | null | undefined, ctx: ToolContext) {
      const currentSessionId = ctx.session.id;
      const compacted: Array<{ sessionId: string; title: string; tier: 'full' | 'partial'; messagesStripped: number }> = [];
      const skipped: Array<{ sessionId: string; title: string; kind: SkipKind; reason: string }> = [];
      const deferred: Array<{ sessionId: string; title: string }> = [];
      let cursor: string | undefined;
      let totalExamined = 0;
      let pagesLoaded = 0;

      if (!input) input = compactSessionDefaults;
      else {
        if (typeof input.inactiveDays !== 'number')
          input.inactiveDays = compactSessionDefaults.inactiveDays;
        if (typeof input.activeMessages !== 'number')
          input.activeMessages = compactSessionDefaults.activeMessages;
      }

      const inactiveMs = input.inactiveDays! * 24 * 60 * 60 * 1000;
      const opts: Required<CompactSessionsParams> = { inactiveDays: input.inactiveDays!, activeMessages: input.activeMessages! };
      // The edge runs outside every principal scope, so the deferred compaction below has to carry
      // this one in: its store reads and writes are the same ownership-checked operations the inline
      // path performs.
      const principal = currentPrincipal();

      do {
        const page = await store.query({ cursor, limit: 100 });
        cursor = page.cursor;
        pagesLoaded++;

        for (const session of page.items) {
          totalExamined++;

          // The session this tool is being called from is deferred, not skipped. The turn owns its
          // document until it commits, so compacting it inline would be undone by the turn's own
          // write-back seconds later — but it is also the session whose history is being re-sent every
          // round, which makes "never touch it" the wrong answer. Applied at the quiescent edge, by
          // which point the turn has committed and the policy re-decides against what it committed.
          if (session.id === currentSessionId) {
            deferred.push({ sessionId: session.id, title: session.title ?? '' });
            defer(async () => {
              const outcome = await runAs(principal, () => compactOne(store, session.id, opts, inactiveMs));
              // Nothing left to report to: the caller's turn ended to reach this edge.
              if (!outcome.done) console.warn(`[compact_sessions] deferred compaction of the calling session skipped: ${outcome.reason}`);
            });
            continue;
          }

          const outcome = await compactOne(store, session.id, opts, inactiveMs);
          if (outcome.done) compacted.push({ sessionId: session.id, title: session.title ?? '', tier: outcome.tier, messagesStripped: outcome.stripped });
          else              skipped.push({ sessionId: session.id, title: session.title ?? '', kind: outcome.kind, reason: outcome.reason });
        }

        yield { type: 'progress', pct: cursor ? Math.round((totalExamined / (page.total ?? 1)) * 100) : 100, message: `Examined ${totalExamined} sessions, compacted ${compacted.length}` };
      } while (cursor);

      yield { type: 'result', value: { examined: totalExamined, pages: pagesLoaded, compacted, skipped, deferred } };
    },
  };

  return {
    name: 'compact_sessions',
    description:
`Apply the session compaction policy to the entire session store. Note: this should always be user-initiated
or set up as a background task. Do not use this tool to compact a specific session, use \`session_edit({ action: "compact", ...})\`

Two tiers:
  Tier 1 — Full compact: sessions that are archived OR untouched for >28 days.
    Strips all tool calls, tool results, and thinking blocks from every message.
  Tier 2 — Partial compact: active sessions with >20 messages, keeping the last 10 intact.
    Strips tool calls / tool results / thinking from all earlier messages.
A message left with no content is removed rather than kept empty, so message positions shift.
The session you are called from is compacted too, but only once the current turn commits — it is
reported under \`deferred\`, without a tier or a count, and this turn goes on seeing its full history.
Idempotent — safe to run on a schedule.
Returns a summary of what was compacted, deferred and skipped. Each \`skipped\` entry carries a \`kind\`
saying what to do about it — do not try to read this out of the \`reason\` prose:
  ineligible  — nothing to do and nothing wrong (below the thresholds, or already compacted).
  denied      — you may read that session but not write it (owned by another profile and shared in
                read-only). Asking again will be refused again; only its owner can compact it.
  unavailable — the write could not complete this time (a concurrent edit, or the storage backend
                changed underneath the sweep). A later run may well succeed; nothing is wrong.
None of the three is an error, and none stops the rest of the sweep.`,
    inputSchema: {
      type: 'object',
      properties: {
        inactiveDays:  { type: 'number', description: 'Optional threshold for full compact of old sessions. Default 28' },
        activeMessages:  { type: 'number', description: 'Optional number of the most recent messages to leave uncompacted, for recent sessions. Default 10' },
      },
      additionalProperties: false,
    },
    executor,
  };
}
