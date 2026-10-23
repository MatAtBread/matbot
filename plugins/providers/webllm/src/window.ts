import type { Message, MessageContent, Tool } from '@matatbread/matbot-plugin-api';
import { toChatMessages } from './format.js';

// Fitting a conversation into the model's context window. Two steps, cheapest loss first:
//   1. shrink large tool results in turns before the current one — the bulk a model has already read and
//      answered from, and which a call can fetch again — keeping who asked what and what was decided;
//   2. if that is not enough, leave out the oldest whole turns.
// The session itself is never changed. See the README for what this does not do (summarise).
//
// WebLLM offers no tokenizer ahead of a request, so size is ESTIMATED from rendered length, conservatively.
// A wrong estimate is caught where WebLLM itself refuses (ContextWindowSizeExceededError, at prefill, before
// any output) and the call retries with a stricter one.

export const CHARS_PER_TOKEN = 3;
// Per rendered message: the role and turn markers a chat template wraps around each one.
const TOKENS_PER_MESSAGE = 8;
// Cut to well under the budget, not just under it, so the cut holds for several turns. WebLLM reuses its
// prefill only when a request extends the previous one exactly; a cut that moved every turn would make
// every turn re-read the whole window.
const CUT_TARGET = 0.75;
// A tool result longer than this, in an earlier turn, is cut to its first SHRINK_TO characters.
const SHRINK_OVER = 800;
const SHRINK_TO   = 400;

export interface Fitted {
  messages: Message[];
  /** Turns left out, oldest first. 0 when none were. */
  omitted:  number;
  /** Tool results shrunk in the turns that were kept. */
  shrunk:   number;
}

// A turn is a user message and everything after it up to the next one, so a tool call is never parted from
// its result. Anything before the first user message (an assistant opener, a cut session's head) is turn 0.
function turns(messages: readonly Message[]): Message[][] {
  const out: Message[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || out.length === 0) out.push([m]);
    else out[out.length - 1]!.push(m);
  }
  return out;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result) ?? 'null'; } catch { return String(result); }
}

function shrinkContent(c: MessageContent): { content: MessageContent; shrunk: boolean } {
  if (c.type !== 'tool-result') return { content: c, shrunk: false };
  const text = resultText(c.result);
  if (text.length <= SHRINK_OVER) return { content: c, shrunk: false };
  return {
    content: { ...c, result: `${text.slice(0, SHRINK_TO)}… [${(text.length - SHRINK_TO).toLocaleString('en')} more characters `
      + 'left out to fit the context window; call the tool again to see the whole result]' },
    shrunk: true,
  };
}

// Every turn but the last: the current turn may be about to be answered from its latest result.
function shrinkOld(groups: readonly Message[][]): { groups: Message[][]; shrunk: number[] } {
  const shrunk: number[] = [];
  const out = groups.map((g, i) => {
    let n = 0;
    const kept = i === groups.length - 1 ? g : g.map(m => {
      if (m.role !== 'tool') return m;
      const parts = m.content.map(shrinkContent);
      n += parts.filter(p => p.shrunk).length;
      return parts.some(p => p.shrunk) ? { ...m, content: parts.map(p => p.content) } : m;
    });
    shrunk.push(n);
    return kept;
  });
  return { groups: out, shrunk };
}

function estimate(messages: readonly Message[], tools: readonly Tool[], charsPerToken: number): number {
  const chat = toChatMessages([...messages], tools);
  return chat.reduce((n, m) => n + Math.ceil(m.content.length / charsPerToken) + TOKENS_PER_MESSAGE, 0);
}

// What fitting last decided for each conversation, by its first message's id (the one thing every call of
// a conversation shares), so the next call decides the same and what is sent keeps the same start. Once a
// conversation needed shrinking it stays shrunk — shrinking only ever touches earlier turns, and a turn's
// shrunk form never changes, so staying shrunk is what keeps the start stable. Bounded: a stale entry
// costs only a re-fit.
interface Decision { shrink: true; firstKept?: string }
const decisions = new Map<string, Decision>();
const MAX_DECISIONS = 32;

function remember(conversation: string, decision: Decision): void {
  decisions.delete(conversation);
  decisions.set(conversation, decision);
  for (const key of decisions.keys()) {
    if (decisions.size <= MAX_DECISIONS) break;
    decisions.delete(key);
  }
}

export function forgetFit(messages: readonly Message[]): void {
  const first = messages.find(m => m.role !== 'system');
  if (first) decisions.delete(first.id);
}

/**
 * The messages to send so that the system prompt, the tools and the kept turns fit `budget` tokens. Never
 * leaves out or shrinks the current turn: if that alone does not fit, it is sent anyway and WebLLM's own
 * refusal says so.
 */
export function fitToWindow(
  messages:      readonly Message[],
  tools:         readonly Tool[],
  budget:        number,
  charsPerToken: number = CHARS_PER_TOKEN,
): Fitted {
  const system = messages.filter(m => m.role === 'system');
  const groups = turns(messages.filter(m => m.role !== 'system'));
  const first  = groups[0]?.[0];
  if (!first || groups.length === 1) return { messages: [...messages], omitted: 0, shrunk: 0 };

  const cost = (gs: readonly Message[][], from: number): number =>
    estimate([...system, ...gs.slice(from).flat()], tools, charsPerToken);
  const previous = decisions.get(first.id);

  if (!previous && cost(groups, 0) <= budget) return { messages: [...messages], omitted: 0, shrunk: 0 };

  const { groups: small, shrunk } = shrinkOld(groups);
  const keep = (from: number): Fitted => ({
    messages: [...system, ...small.slice(from).flat()],
    omitted:  from,
    shrunk:   shrunk.slice(from).reduce((a, b) => a + b, 0),
  });

  if (previous?.firstKept !== undefined) {
    const from = small.findIndex(g => g[0]?.id === previous.firstKept);
    if (from > 0 && cost(small, from) <= budget) return keep(from);
  }
  if (cost(small, 0) <= budget) {
    remember(first.id, { shrink: true });
    return keep(0);
  }

  const last = small.length - 1;
  let from = 1;
  while (from < last && cost(small, from) > budget * CUT_TARGET) from++;
  remember(first.id, { shrink: true, firstKept: small[from]![0]!.id });
  return keep(from);
}

// Told to the model in the system prompt, so it does not answer as if it had seen what it has not.
export function omittedNote(omitted: number): string {
  return `Note: the ${omitted === 1 ? 'earliest turn' : `earliest ${omitted} turns`} of this conversation `
    + 'are not shown to you, because the conversation is longer than your context window. If the user refers '
    + 'to something you cannot see, say so rather than guessing.';
}

// WebLLM's refusal, by message as well as name: an error crossing the worker boundary may lose its class.
export function isWindowOverflow(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'ContextWindowSizeExceededError' || /exceed context window size/i.test(e.message);
}
