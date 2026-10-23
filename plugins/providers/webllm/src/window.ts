import type { Message, Tool } from '@matatbread/matbot-plugin-api';
import { toChatMessages } from './format.js';

// Fitting a conversation into the model's context window by leaving out its oldest turns. One strategy of
// several; see the README for what it does not do (summarise what it leaves out).
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

export interface Fitted {
  messages: Message[];
  /** Turns left out, oldest first. 0 when everything fit. */
  omitted:  number;
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

function estimate(messages: readonly Message[], tools: readonly Tool[], charsPerToken: number): number {
  const chat = toChatMessages([...messages], tools);
  return chat.reduce((n, m) => n + Math.ceil(m.content.length / charsPerToken) + TOKENS_PER_MESSAGE, 0);
}

// The cut last made for each conversation, by its first message's id (the one thing every call of a
// conversation shares), so the next call can keep it. Bounded: a stale entry costs only a re-cut.
const cuts = new Map<string, string>();
const MAX_CUTS = 32;

function remember(conversation: string, firstKept: string): void {
  cuts.delete(conversation);
  cuts.set(conversation, firstKept);
  for (const key of cuts.keys()) {
    if (cuts.size <= MAX_CUTS) break;
    cuts.delete(key);
  }
}

export function forgetCut(messages: readonly Message[]): void {
  const first = messages.find(m => m.role !== 'system');
  if (first) cuts.delete(first.id);
}

/**
 * The messages to send so that the system prompt, the tools and the kept turns fit `budget` tokens. Never
 * leaves out the current turn: if that alone does not fit, it is sent anyway and WebLLM's own refusal says so.
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
  if (!first || groups.length === 1) return { messages: [...messages], omitted: 0 };

  const cost = (from: number): number => estimate([...system, ...groups.slice(from).flat()], tools, charsPerToken);
  const keep = (from: number): Fitted => ({ messages: [...system, ...groups.slice(from).flat()], omitted: from });

  const previous = cuts.get(first.id);
  if (previous !== undefined) {
    const from = groups.findIndex(g => g[0]?.id === previous);
    if (from > 0 && cost(from) <= budget) return keep(from);
  }
  if (cost(0) <= budget) {
    cuts.delete(first.id);
    return keep(0);
  }

  const last = groups.length - 1;
  let from = 1;
  while (from < last && cost(from) > budget * CUT_TARGET) from++;
  remember(first.id, groups[from]![0]!.id);
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
