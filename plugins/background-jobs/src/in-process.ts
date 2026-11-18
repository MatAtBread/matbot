import type { AppendMessage, MatbotMachine, Session, SessionAppender } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { drainEphemeralTurn } from '@matatbread/matbot-core';
import { appendFor, filterJobTriggers, jobContext, jobInfo, REPLY_TAIL, type JobRunner, type JobTriggers, type RunOutcome, type RunSpec } from './jobs.js';

// The job turns in flight here that withhold triggers, by their ephemeral session's id: a job's turn runs on
// this machine beside every conversation, so the filter has to tell them apart, and the id is minted here.
const withheld = new Map<string, JobTriggers>();

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
export async function inProcessRunner(machine: MatbotMachine): Promise<JobRunner | undefined> {
  if (machine.ephemeral === undefined) {
    console.warn('[background-jobs] this matbot has no ephemeral session runner, so no job can run in it.');
    return undefined;
  }
  const ephemeral = machine.ephemeral.bind(machine);
  await filterJobTriggers(machine, session => withheld.get(session.id));
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
          appended += result.traceId !== undefined ? 1 : result.messageIds.length;   // a robo-submit is minted later
          return result;
        },
      };
      // The job's framing rides in its own first message, not the system context: a registered contributor
      // is machine-wide, and would tell every conversation in this process that it is a background job.
      // A cancel or an unload stops the turn itself (see drainEphemeralTurn), so it cannot report after the
      // job is gone.
      const context   = jobContext(await jobInfo(machine, job));
      const sessionId = crypto.randomUUID();
      if (job.triggers !== undefined && job.triggers !== 'all') withheld.set(sessionId, job.triggers);
      try {
        const { session } = await drainEphemeralTurn(ephemeral({ appender }), {
          signal, provider, principal, sessionId,
          content: [
            { type: 'text', origin: 'robo', text: context },
            { type: 'text', text: job.prompt },
          ],
        });
        return { appended, reply: lastReply(session).slice(-REPLY_TAIL) };
      } finally {
        withheld.delete(sessionId);
      }
    },
  };
}

function lastReply(session: Session | undefined): string {
  const last = session?.messages.findLast(m => m.role === 'assistant');
  return (last?.content ?? []).flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n').trim();
}
