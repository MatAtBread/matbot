import type { Session } from '@matatbread/matbot-plugin-api';

/** Content types preserved through compaction (everything else — tool-call, tool-result, thinking,
 *  thinking-redacted, reasoning, image, document, audio — is stripped). */
const KEEP_TYPES = new Set(['text', 'refusal', 'marker']);

/**
 * Strip every non-kept block from the messages before `msgIndex` (negative counts from the end, like
 * `Array.slice`), and drop any message left with nothing.
 *
 * The one implementation of what compaction *means*, shared by the `session_edit` `compact` action and
 * the `compact_sessions` policy — the two differ in which sessions and which cutoff, never in this.
 *
 * `stripped` counts messages changed, dropped included, which is what makes the whole thing idempotent
 * at the caller: a second pass finds nothing to do and reports zero.
 */
export function compactBefore(messages: Session['messages'], msgIndex: number): { messages: Session['messages']; stripped: number } {
  const idx = msgIndex < 0 ? messages.length + msgIndex : msgIndex;
  if (idx <= 0) return { messages, stripped: 0 };

  let stripped = 0;
  const compacted = messages.flatMap((m, i) => {
    if (i >= idx) return [m];                             // past the cutoff — untouched
    const kept = m.content.filter(c => KEEP_TYPES.has(c.type));
    // Nothing left to say: drop the message rather than leave an empty shell. No provider ever saw
    // one (the Anthropic converter skips empty content and folds the adjacent same-role messages
    // either side of the gap), while a frontend reading the stored array draws it as an empty bubble.
    // Both sides of a tool exchange are stripped in the same pass, so they disappear together and no
    // call is left without its result. Tested before "nothing to strip", for which a shell left by an
    // earlier compaction reads as equal-length — both zero — and would survive the cleanup.
    if (kept.length === 0) { stripped++; return []; }
    if (kept.length === m.content.length) return [m];     // nothing to strip
    stripped++;
    return [{ ...m, content: kept }];
  });
  return { messages: compacted, stripped };
}
