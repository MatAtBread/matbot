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
 * Safety: the current session (ctx.session.id) is never touched. Each edit is individually wrapped
 * so one failure does not abort the rest. Idempotent: a session whose content has already been
 * stripped yields 0 messagesStripped and no error.
 *
 * Invoke via background tool or call directly as a tool.
 */

import type { Tool, ToolExecutor, ToolContract, ToolContext, ToolResultOf, Session, Store } from '@matatbread/matbot-plugin-api';
import { lastActivityAt } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    compact_sessions: ToolContract<
      {
        examined:  number;
        pages:     number;
        compacted: Array<{ sessionId: string; title: string; tier: 'full' | 'partial'; messagesStripped: number }>;
        skipped:   Array<{ sessionId: string; title: string; reason: string }>;
      },
      { inactiveDays?: number; activeMessages?: number }
    >;
  }
}

/** Content types preserved through compaction (everything else — tool-call, tool-result, thinking,
 *  thinking-redacted, reasoning, image, document, audio — is stripped). Must match the set used by
 *  the `session_edit` tool's `compact` action so behaviour is identical regardless of which code
 *  path performs the compaction. */
const KEEP_TYPES = new Set(['text', 'refusal', 'marker']);

interface CompactSessionsParams {
  inactiveDays?: number; // Threshold for full compact. Default 28
  activeMessages?: number; // Number of messages at the head of the session to NOT compact. Default 10
}

// ── helpers ───────────────────────────────────────────────────────────────────

function compactMessages(messages: Session['messages'], msgIndex: number): { messages: Session['messages']; stripped: number } {
  // msgIndex < 0 is an offset from the end (like JS Array.slice)
  const idx = msgIndex < 0 ? messages.length + msgIndex : msgIndex;
  if (idx <= 0) return { messages, stripped: 0 };

  let stripped = 0;
  const compacted = messages.map((m, i) => {
    if (i >= idx) return m;                           // past the cutoff — untouched
    const filtered = m.content.filter(c => KEEP_TYPES.has(c.type));
    if (filtered.length === m.content.length) return m; // nothing to strip
    stripped++;
    return { ...m, content: filtered };
  });
  return { messages: compacted, stripped };
}

// ── tool factory ──────────────────────────────────────────────────────────────

const compactSessionDefaults: Required<CompactSessionsParams> = { activeMessages: 10, inactiveDays: 28 };
export function makeCompactSessionsTool(store: Store<Session>): Tool<ToolResultOf<'compact_sessions'>> {
  const executor: ToolExecutor<ToolResultOf<'compact_sessions'>> = {
    async *execute(input: CompactSessionsParams | null | undefined, ctx: ToolContext) {
      const currentSessionId = ctx.session.id;
      const compacted: Array<{ sessionId: string; title: string; tier: 'full' | 'partial'; messagesStripped: number }> = [];
      const skipped: Array<{ sessionId: string; title: string; reason: string }> = [];
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

      const inactiveTimestamp = input.inactiveDays! * 24 * 60 * 60 * 1000;

      function isInactiveSession(updatedAt: string): boolean {
        const then = new Date(updatedAt).getTime();
        return Date.now() - then >= inactiveTimestamp;
      }

      do {
        const page = await store.query({ cursor, limit: 100 });
        cursor = page.cursor;
        pagesLoaded++;

        for (const session of page.items) {
          totalExamined++;

          // Never compact the session this tool is being called from
          if (session.id === currentSessionId) {
            skipped.push({ sessionId: session.id, title: session.title ?? '', reason: 'current session' });
            continue;
          }

          // Re-read via get() so the CAS below uses a fresh version — the query result may be stale
          const current = await store.get(session.id);
          if (!current) {
            skipped.push({ sessionId: session.id, title: session.title ?? '', reason: 'deleted before compaction' });
            continue;
          }

          // ── Tier 1 — full compact ──
          if (current.status === 'archived' || isInactiveSession(current.updatedAt)) {
            const { messages, stripped } = compactMessages(current.messages, -1);
            if (stripped === 0) {
              skipped.push({ sessionId: current.id, title: current.title ?? '', reason: 'nothing to strip' });
              continue;
            }
            const next: Session = { ...current, messages, updatedAt: lastActivityAt({ ...current, messages }) };
            const res = await store.cas(current.id, current.version, { ...next, version: crypto.randomUUID() });
            if (!res.ok) {
              skipped.push({ sessionId: current.id, title: current.title ?? '', reason: 'concurrent modification' });
              continue;
            }
            compacted.push({ sessionId: current.id, title: current.title ?? '', tier: 'full', messagesStripped: stripped });
            continue;
          }

          // ── Tier 2 — partial compact ──
          if (current.messages.length > input.activeMessages! * 2) {
            const { messages, stripped } = compactMessages(current.messages, -input.activeMessages!);
            if (stripped === 0) {
              skipped.push({ sessionId: current.id, title: current.title ?? '', reason: 'nothing to strip' });
              continue;
            }
            const next: Session = { ...current, messages, updatedAt: lastActivityAt({ ...current, messages }) };
            const res = await store.cas(current.id, current.version, { ...next, version: crypto.randomUUID() });
            if (!res.ok) {
              skipped.push({ sessionId: current.id, title: current.title ?? '', reason: 'concurrent modification' });
              continue;
            }
            compacted.push({ sessionId: current.id, title: current.title ?? '', tier: 'partial', messagesStripped: stripped });
            continue;
          }

          skipped.push({ sessionId: current.id, title: current.title ?? '', reason: 'below thresholds' });
        }

        yield { type: 'progress', pct: cursor ? Math.round((totalExamined / (page.total ?? 1)) * 100) : 100, message: `Examined ${totalExamined} sessions, compacted ${compacted.length}` };
      } while (cursor);

      yield { type: 'result', value: { examined: totalExamined, pages: pagesLoaded, compacted, skipped } };
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
The current session is never touched. Idempotent — safe to run on a schedule.
Returns a summary of what was compacted and skipped.`,
    inputSchema: {
      type: 'object',
      properties: {
        inactiveDays:  { type: 'number', description: 'Optional threshold for full compact of old sessions. Default 28' },
        activeMessages:  { type: 'number', description: 'Optional number of messages at the head of the session to NOT compact for recent sessions. Default 10' },
      },
      additionalProperties: false,
    },
    executor,
  };
}
