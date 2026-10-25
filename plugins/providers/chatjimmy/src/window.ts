import type { Message, Tool } from '@matatbread/matbot-plugin-api';
import { toChatMessages, type ChatMessage, type RenderOptions } from './format.js';

// Measured on chatjimmy.ai: the prompt and the reply share a window of about 6k tokens. Past it the
// endpoint answers 200 with an empty body; close to it, the reply stops part-way with `done_reason: stop`.
export const DEFAULT_CONTEXT = 6144;
// Room kept for the reply when `maxTokens` does not say how much.
export const REPLY_RESERVE = 1024;
// Measured at ~3.5 characters a token on prose and ~4.5 on matbot's own turns (compact tool specs, JSON
// results). The lower one, since an estimate that runs over the window loses the whole reply.
const CHARS_PER_TOKEN = 3.5;

const OLDER_RESULT_CHARS  = 400;
const LATEST_RESULT_CHARS = 4000;

export interface Fitted {
  systemPrompt: string;
  messages:     ChatMessage[];
  /** What was given up to fit, for the log. Empty when everything fitted. */
  cuts:         string[];
}

export function size(r: { systemPrompt: string; messages: readonly ChatMessage[] }): number {
  return r.systemPrompt.length + r.messages.reduce((n, m) => n + m.content.length, 0);
}

// Tools named in the latest tool result first, in the order it names them, then the rest as offered. The
// latest result is usually what the model acts on next — `tool_search` lists the tools it just loaded,
// best match first — so these are the last to be dropped.
function byPriority(messages: readonly Message[], tools: readonly Tool[]): Tool[] {
  const latest = messages.findLast(m => m.role === 'tool');
  const text = latest?.content.flatMap(c => c.type === 'tool-result'
    ? [typeof c.result === 'string' ? c.result : JSON.stringify(c.result) ?? '']
    : []).join('\n') ?? '';
  const at = (t: Tool): number => {
    const i = text.search(new RegExp(`\\b${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    return i < 0 ? Infinity : i;
  };
  return tools.map((t, i) => ({ t, i, at: at(t) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(x => x.t);
}

/**
 * The request cut down until it fits the window, giving up the least useful thing first: the bulk of
 * older tool results, then the long half of every tool description, then the earliest turns, and last the
 * tools least likely to be needed now. matbot's tool surface alone is several times this window — one
 * `tool_search` loads a dozen full specifications — so on any real turn some of this happens.
 *
 * Throws when even the current turn, with no tools, does not fit: sent, it would come back empty.
 */
export function fitToWindow(messages: readonly Message[], tools: readonly Tool[], budgetTokens: number): Fitted {
  const budget  = budgetTokens * CHARS_PER_TOKEN;
  const offered = tools.length > 0;
  const ranked  = byPriority(messages, tools);
  const opts: RenderOptions = { tools: ranked, offered };
  const cuts: string[] = [];
  const render = () => toChatMessages(messages, opts);

  let r = render();
  const fits = (): boolean => size(r) <= budget;
  if (fits()) return { ...r, cuts };

  // Each step is reported only if it changed something: a cap no result reached is not a cut, and
  // "tool results shortened" in the log, for results nowhere near the cap, read as a truncation to chase.
  const step = (label: string): boolean => {
    const before = size(r);
    r = render();
    if (size(r) < before) cuts.push(label);
    return fits();
  };

  opts.olderResultChars  = OLDER_RESULT_CHARS;
  opts.latestResultChars = LATEST_RESULT_CHARS;
  if (step('tool results shortened')) return { ...r, cuts };

  if (offered) {
    opts.compact = true;
    if (step('tool descriptions shortened')) return { ...r, cuts };
  }

  // Whole turns, oldest first, never the one being answered.
  const turnStarts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  let dropped = 0;
  for (const start of turnStarts.slice(1)) {
    opts.from = start;
    dropped++;
    r = render();
    if (fits()) break;
  }
  if (dropped > 0) cuts.push(`${dropped} earliest turn${dropped === 1 ? '' : 's'} left out`);
  if (fits()) return { ...r, cuts };

  let shown = ranked.length;
  while (shown > 0 && !fits()) {
    shown--;
    opts.tools  = ranked.slice(0, shown);
    opts.hidden = ranked.length - shown;
    r = render();
  }
  if (shown < ranked.length) cuts.push(`${ranked.length - shown} of ${ranked.length} tools left out`);
  if (fits()) return { ...r, cuts };

  throw new Error(`ChatJimmy: the conversation does not fit its ~${budgetTokens}-token prompt budget even with every tool `
    + 'and all earlier turns left out — the system prompt and the current turn alone are too long '
    + `(${size(r)} characters). Start a new conversation, or use another provider for this.`);
}
