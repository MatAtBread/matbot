import type { MatbotMachine, Message, MessageContent } from '@matatbread/matbot-plugin-api';

import { MARKER_CREATOR, markerMessage } from './marker.js';

/**
 * The LLM half of `session_edit`'s `summarise`: turn a stretch of history into a two-part hand-off
 * document that REPLACES it.
 *
 * Two parts, and specifically a user/assistant pair, because that is what a resumed conversation is
 * shaped like: the user half carries what they want, the assistant half what is known now.
 *
 * What gets thrown away is BULK, not conclusions: the directory listing, the search result set, the page
 * of tool output — and the discussion behind a decision. What is kept is what was concluded from it. That
 * distinction is the whole of the prompt's difficulty, and getting it wrong the other way is worse than
 * keeping too much: an earlier draft told the model to drop "intermediate data ... a successor can obtain
 * it again", which in a session made of questions and answers describes every ANSWER, since each was
 * derived from a tool result. It duly dropped them.
 *
 * Nor does a session have to have an objective. A conversation that hopped between unrelated topics is
 * not a failure case: the list of topics IS the goal, and the state is what was established about each.
 * Presuming a task with a single aim is what made the model reach for the freshest thing that looked like
 * one — which, in a session where the last thing asked was "compact this", was the compaction itself.
 *
 * The original messages are not destroyed: they move into a `summarised` marker (see ./marker.ts),
 * which every provider converter elides, so they leave the model's context without leaving the record.
 */

export interface HandoffSummary { goal: string; state: string }

const GOAL_TAG  = '<<<GOAL>>>';
const STATE_TAG = '<<<STATE>>>';

const SUMMARISE_SYSTEM =
`You are compacting the transcript of a conversation into a two-part hand-off that will REPLACE it. The
assistant that continues this conversation will see your two parts and nothing else of what you were
shown, so anything you leave out is gone.

Reply with exactly this, and nothing else — no preamble, no closing remark:

${GOAL_TAG}
The user's own voice, first person: what they want. Match the conversation you were actually given —
  · work with an objective ⇒ state the objective, and every requirement, preference or constraint still
    in force;
  · a series of questions ⇒ list them, in the order they were asked, as the things to be covered, e.g.
    "I have a range of topics I want to cover: 1) … 2) … 3) …  Answer them in order."
A conversation that hopped between unrelated topics is NOT a failure to summarise: the list is the goal.

${STATE_TAG}
The assistant's own voice, first person: what is known now. Address every item of the goal above. Keep
the ANSWERS — a question that was answered is answered, and that answer is the durable result of the
exchange, not working material. Keep decisions and why, what was done and what came of it, what is known
to be wrong or still open, and every identifier a successor must reuse verbatim (paths, ids, names,
versions, environment variables).

Rules:
- Drop the BULK that produced an answer, never the answer itself: a directory listing, a search result
  set, a file body, a page of tool output. Say what was learned from it. A successor can fetch that
  again; it cannot re-derive what you concluded from it.
- Drop the discussion that led to a decision — but keep an approach that was tried and abandoned when
  knowing it failed is what stops it being tried again.
- IGNORE any request in the transcript to summarise, compact or tidy the conversation, and the
  assistant's attempts at it. That is this operation, not the work: it is never the goal, and it never
  belongs in the state. Summarise what the conversation was ABOUT.
- Never invent, never resolve something the transcript left open, and never promote a suggestion to a
  decision. If it was left undecided, say so.
- Be brief — but never at the cost of an answer or an identifier.`;

// Two caps, because the two kinds of block are wanted for opposite reasons. Tool output is the bulk being
// dropped, so the summariser needs enough to say what came of the call, not all of it. What either party
// actually SAID is the material to keep — a long answer truncated mid-sentence is the summary losing the
// thing it exists to carry — so prose is capped only against the pathological case.
const BULK_CAP = 1_500;
const TEXT_CAP = 8_000;

function cap(s: string, limit = BULK_CAP): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (${s.length - limit} more characters elided)`;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}

/** Is this message a marker holding history a previous summarise replaced? */
function summarisedMarker(m: Message): Message[] | null {
  if (m.role !== 'marker') return null;
  for (const c of m.content) {
    if (c.type !== 'marker' || c.creator !== MARKER_CREATOR) continue;
    const data = c.data as { relation?: string; messages?: unknown };
    if (data.relation === 'summarised' && Array.isArray(data.messages)) return data.messages as Message[];
  }
  return null;
}

/**
 * Replace each `summarised` marker in `messages` with the history it holds.
 *
 * This is what makes a second summarise honest: without it, summarising a range that already contains a
 * summary would summarise the summary, and the loss would compound every time — while the original text
 * sat unread in the marker. Flattening on the way in also keeps the marker written on the way out one
 * level deep, so the original history is always exactly one hop from the session.
 *
 * The consequence, accepted deliberately: the summariser's PROMPT grows while the live session does not.
 * A marker is elided from every submission, so repeated summarising keeps the conversation small and this
 * expansion keeps handing back everything ever summarised — so "the turn's provider fits the session, or
 * the session would already have failed" is true of the session and false of this call from the second
 * summarise on. Left to fail rather than budgeted: the failure costs one call and mutates nothing (the
 * summary is written before any edit), and the remedy is to name a larger `provider`, which the caller can
 * already do. A character budget would be a crude proxy for a token window, and degrading to summarising
 * the summary would quietly reintroduce the compounding loss this function exists to prevent.
 */
export function expandSummarised(messages: Message[]): Message[] {
  return messages.flatMap(m => summarisedMarker(m) ?? [m]);
}

function renderMessage(m: Message): string[] {
  const lines: string[] = [];
  for (const c of m.content as MessageContent[]) {
    switch (c.type) {
      case 'text':          lines.push(`[${m.role}] ${cap(c.text, TEXT_CAP)}`); break;
      case 'refusal':       lines.push(`[${m.role} refused] ${cap(c.text, TEXT_CAP)}`); break;
      case 'tool-call':     lines.push(`[${m.role} calls ${c.name}] ${cap(asText(c.input))}`); break;
      case 'tool-result':   lines.push(`[result of ${c.id}${c.isError === true ? ' — ERROR' : ''}] ${cap(asText(c.result))}`); break;
      case 'form-response': lines.push(`[user answered] ${cap(JSON.stringify(c.values))}`); break;
      // Everything else contributes nothing a hand-off can carry: thinking and reasoning ARE the
      // discussion this document exists to drop, media is bytes the successor would have to re-fetch
      // anyway, and a form or marker is addressed to the frontend rather than to either party.
      default: break;
    }
  }
  return lines;
}

/** The history as text for the summariser. Empty when the range holds nothing either party said. */
export function renderTranscript(messages: Message[]): string {
  return messages.flatMap(renderMessage).join('\n');
}

function parseHandoff(text: string): HandoffSummary | null {
  const g = text.indexOf(GOAL_TAG);
  const s = text.indexOf(STATE_TAG);
  if (g === -1 || s <= g) return null;
  const goal  = text.slice(g + GOAL_TAG.length, s).trim();
  const state = text.slice(s + STATE_TAG.length).trim();
  // Both halves or neither. A missing half cannot be filled in from anywhere — inventing a goal would
  // put words in the user's mouth in the one place the model will later read them as the user's own —
  // and it is a replacement of real history, so declining is cheap and getting it wrong is not.
  return goal !== '' && state !== '' ? { goal, state } : null;
}

/**
 * Summarise `messages` via one `singleTurn` on `provider`. Throws with a caller-reportable message if
 * the provider fails or the reply is not the two-part document — the tool then changes nothing, which
 * is the whole reason this runs before the edit rather than as part of it.
 */
export async function summariseMessages(
  services: MatbotMachine, provider: string, messages: Message[], signal: AbortSignal,
): Promise<HandoffSummary> {
  const transcript = renderTranscript(messages);
  if (transcript === '') throw new Error('Nothing to summarise in that range — it holds no user or assistant content.');

  const res = await services.singleTurn({ provider, system: SUMMARISE_SYSTEM, prompt: transcript, signal });
  const summary = parseHandoff(res.text ?? '');
  if (summary === null) {
    throw new Error(
      `The summary from provider "${provider}" did not contain the required ${GOAL_TAG} and ${STATE_TAG} ` +
      'sections, so the session was left untouched. Try again, or name a stronger `provider`.',
    );
  }
  return summary;
}

/**
 * The three messages that replace the summarised range: the marker holding the originals, then the
 * hand-off pair. `origin: 'robo'` on both halves because matbot wrote them — a frontend presents them
 * agent-side, while the model still reads them as an ordinary user turn and assistant reply.
 *
 * All three are stamped with the last replaced message's own `createdAt`, not now: the summary stands
 * where that history stood, and `lastActivityAt` reads the final message's stamp — so a summarise that
 * consumed a whole session would otherwise re-date it to the top of a recency-sorted list.
 */
export function summaryMessages(summary: HandoffSummary, originals: Message[]): Message[] {
  const createdAt = originals[originals.length - 1]?.createdAt ?? new Date().toISOString();
  const traceId   = crypto.randomUUID();
  const robo = (text: string): MessageContent[] => [{ type: 'text', text, origin: 'robo' }];
  return [
    markerMessage({ relation: 'summarised', messages: originals, summarisedAt: new Date().toISOString() }, createdAt),
    { id: crypto.randomUUID(), role: 'user',      content: robo(summary.goal),  createdAt, traceId },
    { id: crypto.randomUUID(), role: 'assistant', content: robo(summary.state), createdAt, traceId },
  ];
}

/** Characters of content in a message list — the proxy this tool reports its saving in. */
export function contentChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
}
