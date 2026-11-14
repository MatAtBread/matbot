import type { MarkerData, Message, MessageContent, MatbotMachine, Principal, SessionAppender, ToolContext, UserContent } from '@matatbread/matbot-plugin-api';
import { createMessage, defaultingPrompt, failureOf, rejectingPrompt, SUB_TURN_CREATOR } from '@matatbread/matbot-plugin-api';
import { recordUsage } from '@matatbread/matbot-plugin-api/host';
import { drainEphemeralTurn } from './ephemeral-turn.js';
import { TRUNCATION_CREATOR, withFailureNote } from './runner.js';
import { RETRACTION_CREATOR } from './session-runner.js';
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

// Returning a value to the caller and writing to a conversation are different acts, and a prompt can ask for
// either ("append the time here and return nothing"), so a sub-turn appends as any turn does: through the
// machine's appender, to any session it names. Two things are its own: an append naming no session goes to
// the calling conversation, whose id this run has (the run's own session is a private copy nobody reads), and
// a robo-submit says it came from a sub-turn, for the model that answers it.
function fromSubTurn(machine: MatbotMachine, sessionId: string): SessionAppender {
  return {
    defaultSessionId: sessionId,
    async append(target, messages) {
      const appender = machine.SessionAppender;
      if (appender === undefined) throw new Error('This matbot cannot append to a conversation.');
      return appender.append(target ?? sessionId, messages.map(m => m.role === 'user' ? { from: 'a sub-turn run from this conversation', ...m } : m));
    },
  };
}

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

// Core's record of how the RUN went — its depth, a cut-off reply, a retracted answer, a hook that threw — which
// describes a transcript that is thrown away, so it stays with it. Raising the session's depth would be the
// worst of them.
const RUN_BOOKKEEPING: ReadonlySet<string> = new Set<keyof MarkerData | 'matbot-retraction'>([
  SUB_TURN_CREATOR, TRUNCATION_CREATOR, RETRACTION_CREATOR, 'matbot-hooks',
]);

/** Every other marker a sub-turn's run produced: what its tools recorded about the session (data it kept, a
 *  function it defined), which belongs to the session the sub-turn ran within. A sub-turn is part of the
 *  calling turn's work, and no flag decides this, because nothing calling one can know what its tools will
 *  record. */
function carriedMarkers(own: readonly Message[]): MessageContent[] {
  return own.filter(m => m.role === 'marker')
    .flatMap(m => m.content.filter(c => c.type === 'marker' && !RUN_BOOKKEEPING.has(c.creator)));
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
 * it holds for the session, while what the run writes never reaches the session itself — except the markers
 * its tools recorded, which go to `carry` for the caller to yield as its own, so the runner stores them in the
 * session as it would the caller's. A turn that failed carries nothing: a crash must not commit half a turn.
 */
export async function runSubTurn(
  machine: MatbotMachine,
  turn:    { content: UserContent[]; provider: string; transcript: boolean },
  seed:    readonly Message[],
  principal: Principal,
  ctx:     ToolContext,
  signal:  AbortSignal,
  carry:   (markers: MessageContent[]) => void,
): Promise<SubTurnWork | SubTurnFailure> {
  if (signal.aborted) return { ok: false, error: 'Cancelled before it started.' };
  try {
    const seeded = new Set(seed.map(m => m.id));
    const { session, failure } = await drainEphemeralTurn(machine.ephemeral!({ appender: fromSubTurn(machine, ctx.session.id) }), {
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
    carry(carriedMarkers(own));
    return reduce(own, turn.transcript);
  } catch (e) {
    // Refused media, chiefly, which is raised before the turn exists: its message names the file.
    return { ok: false, error: withFailureNote(e instanceof Error ? e.message : String(e), failureOf(e)) };
  }
}
