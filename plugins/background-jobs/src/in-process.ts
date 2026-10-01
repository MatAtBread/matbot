import type { AppendMessage, MatbotMachine, Session, SessionAppender } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { appendFor, jobContext, jobInfo, REPLY_TAIL, type JobRunner, type RunOutcome, type RunSpec } from './jobs.js';

/**
 * A job's turn on an ephemeral run in this process: a private runner over an in-memory session, so the
 * job's own transcript is never stored, announced or listed, and it shares every tool and provider with
 * the conversations around it. It reports through its run's appender, which the scheduler labels with the
 * job and points at the conversation the job was made from.
 *
 * Unlike a child process, it cannot be killed — only aborted, which a tool may ignore — and it shares this
 * process's heap. Its tools defend themselves as a chat turn's do; `matbot-background-jobs-node` is the
 * choice for jobs that need the harder boundary.
 */
export function inProcessRunner(machine: MatbotMachine): JobRunner | undefined {
  if (machine.ephemeral === undefined) {
    console.warn('[background-jobs] this matbot has no ephemeral session runner, so no job can run in it.');
    return undefined;
  }
  const ephemeral = machine.ephemeral.bind(machine);
  return {
    async run(job: RunSpec, signal: AbortSignal): Promise<RunOutcome | undefined> {
      const provider  = job.provider ?? machine.providers.keys().next().value;
      const principal = job.principal ?? tryCurrentPrincipal();
      if (provider === undefined || principal === undefined) {
        console.error(`[background-jobs] job ${job.name ?? job.id} has no ${provider === undefined ? 'provider' : 'principal'} to run as; skipped.`);
        return undefined;
      }

      let appended = 0;
      const appender: SessionAppender = {
        ...(job.session !== undefined ? { defaultSessionId: job.session } : {}),
        async append(sessionId: string | undefined, messages: readonly AppendMessage[]) {
          const result = await appendFor(machine, job, sessionId, messages);
          appended += result.messageIds.length;
          return result;
        },
      };
      const { sessions, run } = ephemeral({ appender });

      const now = new Date().toISOString();
      const session: Session = { id: crypto.randomUUID(), version: crypto.randomUUID(), status: 'active', messages: [], createdAt: now, updatedAt: now };
      await sessions.set(session.id, session);

      // The job's framing rides in its own first message, not the system context: a registered contributor
      // is machine-wide, and would tell every conversation in this process that it is a background job.
      const context = jobContext(await jobInfo(machine, job));
      const view = await run.open({
        sessionId: session.id, signal, provider, principal,
        content: [
          { type: 'text', origin: 'robo', text: context },
          { type: 'text', text: job.prompt },
        ],
      });

      // `signal` on open() only ends this view of the session; the turn runs on the runner's own controller.
      // So a cancel or an unload stops the turn itself — otherwise it would carry on calling tools, and could
      // still report, after the job was gone.
      const stop = (): void => { run.abort(session.id); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      let final: Session | undefined;
      try {
        for await (const ev of view.events) {
          if (!('traceId' in ev) || ev.traceId !== view.traceId) continue;
          if (ev.type === 'done' || ev.type === 'aborted') { final = ev.session; break; }
          if (ev.type === 'error') break;
        }
      } finally {
        signal.removeEventListener('abort', stop);
      }
      final ??= (await sessions.get(session.id)) ?? undefined;
      return { appended, reply: lastReply(final).slice(-REPLY_TAIL) };
    },
  };
}

function lastReply(session: Session | undefined): string {
  const last = session?.messages.findLast(m => m.role === 'assistant');
  return (last?.content ?? []).flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n').trim();
}
