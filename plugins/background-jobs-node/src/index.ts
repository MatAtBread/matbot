import { spawn } from 'node:child_process';
import { execArgv, argv, execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync }       from 'node:fs';
import { pathToFileURL }    from 'node:url';
import type { MatbotMachine, MatbotPluginSpec, AppendResult } from '@matatbread/matbot-plugin-api';
import { ItemChangeKind } from '@matatbread/matbot-plugin-api';
import {
  createBackgroundJobsPlugin, appendFor, jobContext, jobInfo, REPLY_TAIL,
  type JobInfo, type JobRunner, type RunOutcome, type RunSpec,
} from '@matatbread/matbot-background-jobs';
import { connectToParent, relayable, serveJob, type Endpoint, type ParentLink } from './channel.js';

// `matbot-background-jobs` with each job run in a child process of its own: a full matbot booted from
// this one's config, which shares its storage and none of its turns. The process is the boundary — a job
// that hangs or leaks can be killed outright, and nothing it does touches this process's heap — at the
// cost of a whole boot per run. The child never writes a session itself; it asks over an IPC channel,
// and what it changes elsewhere is announced back over the same channel.

// When true, jobs run in a new process group and survive the parent exiting.
const DETACH_JOBS = false;

// Relative path args (--import, --require, --loader) resolve against the CWD at launch time, which may
// differ from dirname(argv[1]). Walk up from the script directory until we find the file, then emit a
// file:// URL so the child resolves it regardless of its own CWD.
function absoluteExecArgv(scriptPath: string): string[] {
  return execArgv.map((arg, i, arr) => {
    const prev = arr[i - 1];
    if (prev !== undefined && ['--import', '--require', '--loader'].includes(prev)) {
      if (arg.startsWith('./') || arg.startsWith('../')) {
        let dir = dirname(scriptPath);
        while (true) {
          const candidate = resolve(dir, arg);
          if (existsSync(candidate)) return pathToFileURL(candidate).href;
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    }
    return arg;
  });
}

function buildJobConfig(configPath: string, prompt: string, provider?: string): string {
  const escapedPath  = configPath.replace(/'/g, "''");
  const indented     = prompt.split('\n').map(l => '  ' + l).join('\n');
  const providerLine = provider !== undefined ? `default_provider: '${provider.replace(/'/g, "''")}'\n` : '';
  return `extends: '${escapedPath}'\nephemeral: true\n${providerLine}prompt: |\n${indented}\n`;
}

// What a job changed, republished here: the job wrote the shared store, so a reader here re-reading
// finds it, but the announcement went to the job's own bus — which nobody here listens to.
function relay(machine: MatbotMachine, job: RunSpec, raw: unknown): void {
  const n = relayable(raw, `job:${job.id}`);
  if (n !== undefined) machine.Notifier.notify(n);
}

function spawnRunner(machine: MatbotMachine): JobRunner | undefined {
  const configPath = machine.configPath;
  const script     = argv[1];
  if (configPath === undefined || script === undefined) {
    console.warn('[background-jobs] no config path or entry script to spawn a job from, so no job can run here.');
    return undefined;
  }

  return {
    async run(job: RunSpec, signal: AbortSignal): Promise<RunOutcome | undefined> {
      const child = spawn(
        execPath,
        [...absoluteExecArgv(script), script, '--config', '-'],
        {
          detached: DETACH_JOBS,
          // stdin carries the job's config, the fourth fd the channel back to this process.
          stdio:    ['pipe', 'pipe', 'inherit', 'ipc'],
          // The env channel carries process identity/mode; the piped config (stdin) carries the task.
          // IS_SUB_AGENT stops the job arming a scheduler of its own; MATBOT_PRINCIPAL delegates the
          // creator's identity so the job runs as them.
          env: {
            ...process.env,
            IS_SUB_AGENT: '1',
            ...(job.principal !== undefined ? { MATBOT_PRINCIPAL: JSON.stringify(job.principal) } : {}),
          },
        },
      );
      if (!child.stdin) return undefined;
      child.stdin.write(buildJobConfig(configPath, job.prompt, job.provider));
      child.stdin.end();

      let tail = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { tail = (tail + chunk).slice(-REPLY_TAIL); });

      let appended = 0;
      serveJob(child as unknown as Endpoint, {
        info:   () => jobInfo(machine, job),
        append: async (sessionId, messages) => {
          const result = await appendFor(machine, job, sessionId, messages);
          appended += result.messageIds.length;
          return result;
        },
        notify: n => relay(machine, job, n),
      });

      // The IPC channel holds the event loop open on its own, so `child.unref()` alone stops working once
      // it exists — a parent with nothing else to do would wait for every job. Measured: 5.1s held versus
      // 72ms released. Unref'ing it does not stop delivery while this process is alive for its own reasons.
      child.channel?.unref();
      (child.stdout as { unref?: () => void } | null)?.unref?.();
      child.unref();

      const kill = (): void => { child.kill(); };
      signal.addEventListener('abort', kill, { once: true });
      await new Promise<void>(r => child.once('exit', () => r()));
      signal.removeEventListener('abort', kill);
      return { appended, reply: tail.trim() };
    },
  };
}

// ── The job's side ────────────────────────────────────────────────────────────

// The job's side of its channel, when this process IS a job.
let parentLink: ParentLink | undefined;

async function setupJob(services: MatbotMachine, signal: AbortSignal): Promise<void> {
  // Spawned by something else — the plugin this replaces, or by hand — there is no channel, and so no
  // way to report: the host's appender keeps refusing, which is the honest answer.
  if (typeof process.send !== 'function' || !process.connected) return;
  // Held only while a request or a send is outstanding (see connectToParent): held for good, it would
  // keep this process alive after its turn has ended; released for good, it would let it exit mid-request.
  const link = connectToParent(process as unknown as Endpoint, process.channel);
  parentLink = link;
  process.once('disconnect', () => link.close('The process that started this job has gone.'));

  let job: JobInfo;
  try { job = await link.request<JobInfo>({ op: 'job' }); }
  catch { return; }

  await services.register('SessionAppender', {
    ...(job.session !== undefined ? { defaultSessionId: job.session } : {}),
    append: (sessionId, messages) => link.request<AppendResult>({
      op: 'append', ...(sessionId !== undefined ? { sessionId } : {}), messages: [...messages],
    }),
  });
  services.systemContext.register(() => jobContext(job));
  // What this job changes, announced where someone is listening. Locally produced only — a relayed one
  // carries an `instance`, and relaying it back would be the loop the field exists to break.
  services.Notifier.consume(
    n => link.post({ op: 'notify', notification: n }),
    signal,
    n => n.kind === ItemChangeKind && n.instance === undefined,
  );
}

export const plugin: MatbotPluginSpec = createBackgroundJobsPlugin({
  description: 'Background jobs — now, at a time, or on an interval — that report into a conversation by appending to it. '
    + 'Each job runs in its own process: it can be killed and shares no heap with the server, at the cost of a full boot per run.',
  runner:   spawnRunner,
  inJob:    setupJob,
  // A job's last announcements are still in the channel when its turn ends; let them go before it exits.
  async teardown() {
    await parentLink?.flush();
    parentLink = undefined;
  },
});
