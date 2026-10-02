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
 * - So does reaching the terminal, which is NOT the end of the run: `followup` is post-commit, so a hook
 *   that resubmits or retracts enqueues a further turn on this runner AFTER the terminal this returns on.
 *   Left armed, it ran on unobserved — calling tools, and appending through the run's appender — past the
 *   transcript its caller was handed and past a cancel that no longer reached it. One turn means one.
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
  try {
    for await (const ev of view.events) {
      // To `idle` — the run quiescing — not to this turn's terminal. `followup` is post-commit, so a hook
      // that resubmits or retracts enqueues a FURTHER turn on this runner after the terminal, and stopping
      // at the terminal left it running with nobody watching: appending through the run's appender, calling
      // tools, past the transcript the caller was handed and past a cancel that no longer reached it.
      // Aborting at the terminal does not close that either — the pop happens before the hook enqueues, so
      // the resubmission is queued after the drain and runs anyway. Waiting is what makes the run's work
      // the caller's: bounded by MAX_RESUBMIT_DEPTH, cancellable throughout, and counted.
      if (ev.type === 'idle') break;
      if (!('traceId' in ev) || ev.traceId !== view.traceId) continue;
      if (ev.type === 'done' || ev.type === 'aborted') final = ev.session;
      yield ev;
    }
  } finally {
    opts.signal.removeEventListener('abort', stop);
    stop();
  }
  // The store, not the terminal's session: a followup turn commits after it, and the transcript is meant to
  // be everything the run did. `final` covers a store that has gone from under it.
  return (await ephemeral.sessions.get(id)) ?? final;
}
