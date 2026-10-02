import type { EphemeralRun, PipelineEvent, Principal, PromptFn, Session, UserContent } from '@matatbread/matbot-plugin-api';

/**
 * One turn on an ephemeral run, from a fresh session to its committed transcript: what a background job
 * and a skill demonstration each do, and each did for itself.
 *
 * Yields the turn's own events, up to and including its terminal, and returns the transcript.
 *
 * Three details are why this is shared rather than rewritten:
 * - `signal` is wired to the run's `abort`. On `open` it only ends this view of the session, while the
 *   turn runs on the runner's own controller. Without the wiring, a cancelled job or compile left its
 *   turn calling tools after its caller had gone.
 * - A caller that stops reading before the terminal aborts the turn for the same reason.
 * - An `error` terminal carries no session, so the transcript is then recovered from the run's store.
 *
 * `sessionId` is for a caller that names the session before the turn starts, to log or check it.
 */
export async function* runEphemeralTurn(
  ephemeral: EphemeralRun,
  opts: {
    content:    UserContent[];
    provider:   string;
    principal:  Principal;
    signal:     AbortSignal;
    prompt?:    PromptFn;
    sessionId?: string;
  },
): AsyncGenerator<PipelineEvent, Session | undefined> {
  const now = new Date().toISOString();
  const id  = opts.sessionId ?? crypto.randomUUID();
  await ephemeral.sessions.set(id, { id, version: crypto.randomUUID(), status: 'active', messages: [], createdAt: now, updatedAt: now });

  const view = await ephemeral.run.open({
    sessionId: id, signal: opts.signal, provider: opts.provider, principal: opts.principal, content: opts.content,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  });
  const stop = (): void => { ephemeral.run.abort(id); };
  opts.signal.addEventListener('abort', stop, { once: true });
  if (opts.signal.aborted) stop();

  let final: Session | undefined;
  let ended = false;
  try {
    for await (const ev of view.events) {
      if (!('traceId' in ev) || ev.traceId !== view.traceId) continue;
      ended = ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error';
      if (ev.type === 'done' || ev.type === 'aborted') final = ev.session;
      yield ev;
      if (ended) break;
    }
  } finally {
    opts.signal.removeEventListener('abort', stop);
    if (!ended) stop();
  }
  return final ?? (await ephemeral.sessions.get(id)) ?? undefined;
}
