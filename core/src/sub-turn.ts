import type { Message, MatbotMachine, Principal, SessionAppender, ToolContext, UserContent } from '@matatbread/matbot-plugin-api';
import { createMessage, defaultingPrompt, rejectingPrompt, SUB_TURN_CREATOR } from '@matatbread/matbot-plugin-api';
import { recordUsage } from '@matatbread/matbot-plugin-api/host';
import { drainEphemeralTurn } from './ephemeral-turn.js';
import { usageEntries } from './usage.js';

/** A conversation's own turn is depth 0, so this allows a sub-turn and a sub-turn that one starts, and no
 *  further. Each level multiplies the fan-out, which is why it is small. */
export const MAX_SUB_TURN_DEPTH = 2;

export interface SubTurnWork {
  ok:        true;
  text:      string;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  messages?: Message[];
}
export interface SubTurnFailure { ok: false; error: string }

// It reports by returning. An append from a sub-turn could only be a report to a conversation that is about
// to get the result anyway, and pretending to accept one would tell the model it had been delivered.
const NOWHERE: SessionAppender = {
  async append() {
    throw new Error('A sub-turn reports by returning its result, so nothing it says is appended to a conversation.');
  },
};

function reduce(messages: readonly Message[], transcript: boolean): SubTurnWork {
  const results = new Map<string, boolean>();
  for (const m of messages) for (const c of m.content) if (c.type === 'tool-result') results.set(c.id, c.isError === true);

  const toolCalls: SubTurnWork['toolCalls'] = [];
  let text = '';
  for (const m of messages) {
    const said: string[] = [];
    for (const c of m.content) {
      if      (c.type === 'tool-call') toolCalls.push({ name: c.name, input: c.input, isError: results.get(c.id) ?? true });
      else if (c.type === 'text' && m.role === 'assistant') said.push(c.text);
    }
    if (said.length > 0) text = said.join('\n').trim();
  }
  return { ok: true, text, toolCalls, ...(transcript ? { messages: [...messages] } : {}) };
}

// A completion inside a sub-turn accrues to that turn's own head, which is thrown away with its transcript,
// and its roll-up into the calling tool's scope names a head the calling session does not have, so the flush
// drops it. Recording each entry again here is what puts the spend on the calling turn, attributed to the tool
// call as any tool's completion is. It is not in the result: spend is accounting, read from the ledger, and is
// of no use to a model in the conversation.
function chargeToCaller(messages: readonly Message[]): void {
  for (const { provider, usage, startedAt, durationMs } of usageEntries(messages)) {
    recordUsage(provider, usage, startedAt !== undefined && durationMs !== undefined ? { startedAt, durationMs } : undefined);
  }
}

/** What a sub-turn's private transcript starts from: the caller's markers, because what a session's tools are
 *  can depend on them (a session-scoped function is stored as one) and a marker never reaches a model, then
 *  one more, recording the depth. */
export function subTurnSeed(messages: readonly Message[], depth: number): Message[] {
  const inherited = messages.filter(m => m.role === 'marker' && !m.content.some(c => c.type === 'marker' && c.creator === SUB_TURN_CREATOR));
  return [...inherited, createMessage({ role: 'marker', traceId: crypto.randomUUID(), content: [{ type: 'marker', creator: SUB_TURN_CREATOR, data: { depth } }] })];
}

/** The line a sub-turn's message opens with. Machine-authored, so it is marked as such. */
export function subTurnFrame(sessionId: string): UserContent {
  return {
    type: 'text', origin: 'robo',
    text: sessionId.startsWith('#')
      ? 'You are carrying out one task for another agent. What you finally say is returned to that agent.'
      : `You are carrying out one task for another agent, within conversation ${sessionId}. Its history is not shown to you. What you finally say is returned to that agent.`,
  };
}

/**
 * One full agent turn within the calling session, run on an ephemeral run's private store under the
 * session's own id: so it has the session's principal, tools and gate answers, and an answer a person gives
 * it holds for the session, while what the run writes never reaches the session itself.
 */
export async function runSubTurn(
  machine: MatbotMachine,
  turn:    { content: UserContent[]; provider: string; transcript: boolean },
  seed:    readonly Message[],
  principal: Principal,
  ctx:     ToolContext,
  signal:  AbortSignal,
): Promise<SubTurnWork | SubTurnFailure> {
  if (signal.aborted) return { ok: false, error: 'Cancelled before it started.' };
  try {
    const seeded = new Set(seed.map(m => m.id));
    const { session, failure } = await drainEphemeralTurn(machine.ephemeral!({ appender: NOWHERE }), {
      sessionId: ctx.session.id, signal, principal, provider: turn.provider,
      // Only a real channel. Handed on as one, a stand-in would answer this turn's gates itself, or throw:
      // "nobody is here" has to reach them as no channel at all, so that each site's fallback answers.
      ...(ctx.prompt !== defaultingPrompt && ctx.prompt !== rejectingPrompt ? { prompt: ctx.prompt } : {}),
      initialMessages: [...seed],
      content: turn.content,
    });
    const own = session?.messages.filter(m => !seeded.has(m.id)) ?? [];
    chargeToCaller(own);
    if (failure !== undefined) return { ok: false, error: failure };
    if (session === undefined) return { ok: false, error: 'The turn left no transcript.' };
    return reduce(own, turn.transcript);
  } catch (e) {
    // Refused media, chiefly, which is raised before the turn exists: its message names the file.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
