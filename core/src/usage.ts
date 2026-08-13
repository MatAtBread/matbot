import type { Message, Usage, UsageRecord } from './types.js';

/** Fold one usage tally into a running total; optional fields are summed only when either side has them. */
export function addUsage(acc: Usage | undefined, next: Usage): Usage {
  const a = acc ?? { inputTokens: 0, outputTokens: 0 };
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens:  a.inputTokens  + next.inputTokens,
    outputTokens: a.outputTokens + next.outputTokens,
    ...(((c) => c !== undefined ? { costUsd:             c } : {}))(add(a.costUsd,             next.costUsd)),
    ...(((c) => c !== undefined ? { cacheReadTokens:     c } : {}))(add(a.cacheReadTokens,     next.cacheReadTokens)),
    ...(((c) => c !== undefined ? { cacheCreationTokens: c } : {}))(add(a.cacheCreationTokens, next.cacheCreationTokens)),
  };
}

/**
 * Every accounting entry carried by these messages, in message order.
 *
 * Entries are anchored on turn heads and are self-describing (`site`, `traceId`), so this is a flat
 * read with no correlation to do — filter it for whatever question is being asked: one turn
 * (`traceId`), one tool call (`site`), one session (pass the lot).
 *
 * Tolerates sessions written before accounting moved onto the turn head: an assistant message's own
 * `usage` object and a `tool-result`'s `usage` array are both read as entries, so an existing session
 * still totals correctly. Neither shape is written any more.
 */
export function usageEntries(messages: Iterable<Message>): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const m of messages) {
    if (Array.isArray(m.usage)) {
      out.push(...m.usage);
    } else if (m.usage !== undefined && m.providerName !== undefined) {
      out.push({ provider: m.providerName, usage: m.usage, traceId: m.traceId });
    }
    for (const c of m.content) {
      const legacy = c.type === 'tool-result' ? (c as { usage?: UsageRecord[] }).usage : undefined;
      if (legacy !== undefined) out.push(...legacy);
    }
  }
  return out;
}

/**
 * Aggregate the token accounting on a set of messages, keyed by the provider billed. Pass a single
 * turn's messages (filtered by `traceId`) for a per-turn breakdown, or a whole session for its total.
 *
 * Note what this deliberately does NOT do: sum a provider's `reported` fields across providers. The
 * same key means different things under different protocols (`prompt_tokens` includes cache hits,
 * `input_tokens` does not), so only the normalised counters are comparable across a mixed turn.
 */
export function usageByProvider(messages: Iterable<Message>): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const r of usageEntries(messages)) {
    out.set(r.provider, addUsage(out.get(r.provider), r.usage));
  }
  return out;
}
