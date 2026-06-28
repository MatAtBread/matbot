import type { Message, Usage } from './types.js';

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
 * Aggregate the token accounting recorded on a set of messages, keyed by the provider billed: an
 * assistant turn's own `Message.usage` (billed to its `providerName`) plus every `tool-result` block's
 * `usage` records (each provider-tagged — a tool may run completions against several). Pass a single
 * turn's messages (filtered by `traceId`) for a per-turn breakdown, or a whole session for its total.
 */
export function usageByProvider(messages: Iterable<Message>): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const m of messages) {
    if (m.usage !== undefined && m.providerName !== undefined) {
      out.set(m.providerName, addUsage(out.get(m.providerName), m.usage));
    }
    for (const c of m.content) {
      if (c.type === 'tool-result' && c.usage !== undefined) {
        for (const r of c.usage) out.set(r.provider, addUsage(out.get(r.provider), r.usage));
      }
    }
  }
  return out;
}
