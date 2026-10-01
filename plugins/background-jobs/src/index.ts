import { spawn, type ChildProcess } from 'node:child_process';
import { execArgv, argv, execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync }       from 'node:fs';
import { pathToFileURL }    from 'node:url';
import { randomUUID }       from 'node:crypto';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolContract, ToolResultOf, ToolContext, Store, Principal,
  AppendMessage, AppendResult,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal, isReadOnlyError, runAs, ItemChangeKind } from '@matatbread/matbot-plugin-api';
import { connectToParent, relayable, serveJob, type Endpoint, type JobInfo, type ParentLink } from './channel.js';

// The successor to `@matatbread/matbot-tool-background`, with one change of meaning: a job's reply is
// not its output. Nothing a job prints reaches anyone; it reports by appending to a conversation
// (session_action append), writing a file or sending a notification — whichever its prompt asks for —
// and stays silent when there is nothing to say. That last part is the reason: a job that may have
// nothing worth saying can only be honest if saying is something it does, not something it is.
//
// Its own tool names (`background_job`, `background_job_action`) and its own store. The names differ
// because the meaning does: two tools under one name with different contracts would leave tool-types to
// pick which contract describes the loaded one by file order. The old plugin's schedules keep their old
// meaning there; this plugin lists them (marked legacy) and can cancel them, so moving one across is:
// create it here, cancel it there.

// Why a schedule was left alone, split the way a caller has to act on it — the 4xx/5xx distinction.
// `denied` will be refused again however many times it is asked; `unavailable` may succeed later. `reason`
// is the prose; branch on `kind`, never on the prose.
type SkipKind = 'denied' | 'unavailable';
interface SkippedJob { id: string; kind: SkipKind; reason: string }

/**
 * The two string shapes this tool accepts, as types rather than as prose in a description — the
 * validation regexes below, restated where a caller can be held to them. Deliberately approximate at
 * the edges; the executor validates regardless. The correspondence between each regex and its type is
 * asserted in exactly one place: `isDuration` for one, `isoAt` for the other.
 */
type Duration   = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;
type IsoInstant = `${number}-${number}-${number}` | `${number}-${number}-${number}T${string}`;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // Discriminates on which timing field is present, not an `action` field: `interval` is recurring,
    // `at` a single run at a stated time, neither a single run starting now. `session` in every result is
    // the conversation the job reports to, resolved at creation — absent when there is none.
    background_job:
      | ToolContract<{ id: string; interval: Duration; name?: string; session?: string }, { prompt: string; interval: Duration; name?: string; session?: string; provider?: string }>
      | ToolContract<{ id: string; at: IsoInstant; name?: string; session?: string }, { prompt: string; at: Duration | IsoInstant; name?: string; session?: string; provider?: string }>
      | ToolContract<{ status: 'started'; name?: string; session?: string }, { prompt: string; interval?: 'once' | null; name?: string; session?: string; provider?: string }>;
    background_job_action:
      // A legacy row is a schedule left by `@matatbread/matbot-tool-background`: listed so it can be moved
      // here, never run by this plugin.
      | ToolContract<Array<Job | LegacyJob>, { action: 'list' }>
      | ToolContract<{ resumed:   true; count: number; ids: string[]; skipped?: SkippedJob[] } | { resumed:   true; id: string }, { action: 'resume';  id: string }>
      | ToolContract<{ suspended: true; count: number; ids: string[]; skipped?: SkippedJob[] } | { suspended: true; id: string }, { action: 'suspend'; id: string }>
      | ToolContract<{ cancelled: true; id: string; legacy?: true }, { action: 'cancel'; id: string }>;
  }
}

// ── Duration helpers ──────────────────────────────────────────────────────────

const DURATION_FACTORS: Record<string, number> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** The one place the duration regex and the `Duration` type are equated. */
function isDuration(s: string): s is Duration { return DURATION_RE.test(s.trim()); }

function durationMs(d: Duration): number {
  const m = DURATION_RE.exec(d.trim())!;
  return parseFloat(m[1]!) * (DURATION_FACTORS[m[2]!] ?? 1);
}

// `toISOString()` returns exactly `IsoInstant` by specification; this is the one place that is asserted.
const isoAt = (ms: number): IsoInstant => new Date(ms).toISOString() as IsoInstant;

// A bare number is rejected rather than left to Date.parse, which reads "5" as a year.
const AT_ABSOLUTE = /^\d{4}-\d{2}-\d{2}/;

/**
 * A DATE-ONLY `at` is midnight UTC by spec; a date-time with no offset is local to the HOST, which is
 * often not where the person is. Left as it is rather than normalised (that would silently move an
 * appointment a browser-hosted user meant locally); the description asks for an explicit offset.
 */
function parseAt(s: string): number {
  const t = s.trim();
  if (isDuration(t)) return Date.now() + durationMs(t);
  const abs = AT_ABSOLUTE.test(t) ? Date.parse(t) : NaN;
  if (Number.isNaN(abs)) {
    throw new Error(`Invalid "at" value "${s}". Give an ISO-8601 date-time ("2026-08-23T09:00:00Z", or ` +
      '"2026-08-23" for midnight UTC), or a duration from now ("90m", "2h", "3d"). Include the offset: ' +
      'a date-time without one is read in the HOST\'s timezone, not yours.');
  }
  return abs;
}

// ── Job types & storage ───────────────────────────────────────────────────────

interface JobBase {
  id:         string;
  version:    string;
  prompt:     string;
  createdAt:  IsoInstant;
  /** When this job next fires. For a one-shot it is the only time it ever fires. */
  nextRun:    IsoInstant;
  active?:    boolean;
  name?:      string;
  /** The conversation the job reports to, resolved when it was created. */
  session?:   string;
  lastRun?:   IsoInstant;
  /** The tail of what the job last printed. Never delivered: kept so a job that should have reported and
   *  didn't can be seen to have, without that verdict landing in anyone's conversation. */
  lastReply?: string;
  provider?:  string;
  /** Creator identity, replayed each fire so a recurring job runs as the user who scheduled it. */
  principal?: Principal;
}

/** Fires every `intervalMs` until suspended or cancelled. */
export interface EveryJob extends JobBase { intervalMs: number }
/** Fires once, at `nextRun`, and deletes itself. The ABSENCE of an interval is what makes it one. */
export interface OnceJob  extends JobBase { intervalMs?: undefined }
export type Job = EveryJob | OnceJob;

/** A schedule stored by `@matatbread/matbot-tool-background`, as this plugin shows it. */
export interface LegacyJob {
  id:          string;
  version:     string;
  prompt:      string;
  nextRun:     string;
  intervalMs?: number;
  name?:       string;
  output?:     string;
  legacy:      true;
}

const LEGACY_NAMESPACE = 'schedules';
const LEGACY_PLUGIN    = '@matatbread/matbot-tool-background';

let jobStore:         Store<Job> | undefined;
let legacyStore:      Store<Omit<LegacyJob, 'legacy'>> | undefined;
let activeConfigPath: string | undefined;
let machine:          MatbotMachine | undefined;
let pluginAc:         AbortController | undefined;
// The job's side of its channel, when this process IS a job.
let parentLink:       ParentLink | undefined;
const activeLoops      = new Map<string, AbortController>();
// One entry per job while it is sleeping; aborting it wakes the sleep early.
const sleepControllers = new Map<string, AbortController>();

// ── Spawn ─────────────────────────────────────────────────────────────────────

// When true, jobs run in a new process group and survive the parent exiting.
const DETACH_JOBS = false;

// Kept of what a job prints, for `lastReply` and the log — the end, since a reply's last words are its point.
const REPLY_TAIL = 2_000;

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

/** What a run needs to know about the job it is running, stored or not. */
interface RunSpec {
  id:         string;
  prompt:     string;
  name?:      string;
  session?:   string;
  provider?:  string;
  principal?: Principal;
}

interface Running {
  child: ChildProcess;
  /** How many messages it appended — 0 at exit is a job that said nothing. */
  appended(): number;
  /** The tail of what it printed. */
  reply(): string;
}

function spawnJob(configPath: string, job: RunSpec): Running | undefined {
  const script = argv[1];
  if (script === undefined) return undefined;

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
    info:   () => jobInfo(job),
    append: async (sessionId, messages) => {
      const result = await appendFor(job, sessionId, messages);
      appended += result.messageIds.length;
      return result;
    },
    notify: n => relay(job, n),
  });

  // The IPC channel holds the event loop open on its own, so `child.unref()` alone stops working once it
  // exists — a parent with nothing else to do would wait for every job. Measured: 5.1s held versus 72ms
  // released. Unref'ing it does not stop delivery while this process is alive for its own reasons.
  child.channel?.unref();
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  child.unref();
  return { child, appended: () => appended, reply: () => tail.trim() };
}

async function jobInfo(job: RunSpec): Promise<JobInfo> {
  let sessionTitle: string | undefined;
  if (job.session !== undefined && machine?.sessions !== undefined) {
    const store = machine.sessions;
    const read  = () => store.get(job.session!);
    const session = await (job.principal !== undefined ? runAs(job.principal, read) : read()).catch(() => null);
    sessionTitle = session?.title;
  }
  return {
    id: job.id,
    ...(job.name     !== undefined ? { name: job.name }       : {}),
    ...(job.session  !== undefined ? { session: job.session } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle }         : {}),
  };
}

// An append from a job runs as the job's creator — whose session it is — and is labelled with the job
// here, from the channel, rather than by anything the job says about itself.
async function appendFor(job: RunSpec, sessionId: string | undefined, messages: AppendMessage[]): Promise<AppendResult> {
  const appender = machine?.SessionAppender;
  if (appender === undefined) throw new Error('This matbot cannot append to sessions.');
  const target = sessionId ?? job.session;
  if (target === undefined) throw new Error('This job reports to no conversation, so name the session to append to.');
  const labelled = messages.map(m => ({
    ...m, metadata: { job: { id: job.id, ...(job.name !== undefined ? { name: job.name } : {}) } },
  }));
  const append = () => appender.append(target, labelled);
  return job.principal !== undefined ? runAs(job.principal, append) : append();
}

// What a job changed, republished here: the job wrote the shared store, so a reader here re-reading
// finds it, but the announcement went to the job's own bus — which nobody here listens to.
function relay(job: RunSpec, raw: unknown): void {
  const n = relayable(raw, `job:${job.id}`);
  if (n !== undefined) machine?.Notifier.notify(n);
}

/** Waits for the run to end, then reports a silent one to the log — never to a conversation. */
async function finished(run: Running, job: RunSpec, signal: AbortSignal): Promise<void> {
  const kill = (): void => { run.child.kill(); };
  signal.addEventListener('abort', kill, { once: true });
  await new Promise<void>(r => run.child.once('exit', () => r()));
  signal.removeEventListener('abort', kill);
  const reply = run.reply();
  if (run.appended() === 0 && reply !== '') {
    console.warn(`[background-jobs] job ${job.name ?? job.id} ended without reporting. Its last words: ${JSON.stringify(reply.slice(-300))}`);
  }
}

// ── Scheduler loop ────────────────────────────────────────────────────────────

// wakeSignal interrupts the sleep without killing the loop (used by suspend/resume). Pass Infinity to
// sleep until one of the signals fires. Listeners are detached on every exit, including the timeout: the
// signals outlive the sleep, so a listener left behind per call would accumulate for the process's life.
function sleep(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || wakeSignal?.aborted) { resolve(); return; }
    let id: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (id !== undefined) clearTimeout(id);
      signal.removeEventListener('abort', done);
      wakeSignal?.removeEventListener('abort', done);
      resolve();
    };
    id = isFinite(ms) ? setTimeout(done, ms) : undefined;
    signal.addEventListener('abort', done, { once: true });
    wakeSignal?.addEventListener('abort', done, { once: true });
  });
}

// setTimeout takes a 32-bit signed delay: hand it more and it fires IMMEDIATELY. A long wait is slept in
// chunks against its deadline, which is also the only form that survives the clock moving under it.
const MAX_TIMEOUT_MS = 2_147_483_647;

async function sleepUntil(deadlineMs: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0 || signal.aborted || wakeSignal?.aborted === true) return;
    await sleep(Math.min(remaining, MAX_TIMEOUT_MS), signal, wakeSignal);
  }
}

function wakeJob(id: string): void {
  const wakeAc = sleepControllers.get(id);
  if (wakeAc) { sleepControllers.delete(id); wakeAc.abort(); }
}

const runSpec = (job: Job): RunSpec => ({
  id: job.id, prompt: job.prompt,
  ...(job.name      !== undefined ? { name: job.name }           : {}),
  ...(job.session   !== undefined ? { session: job.session }     : {}),
  ...(job.provider  !== undefined ? { provider: job.provider }   : {}),
  ...(job.principal !== undefined ? { principal: job.principal } : {}),
});

// A single run at a stated time: no interval, no stagger (its time IS its time), and it ends by deleting
// itself — three of the recurring loop's four decisions inverted, so kept apart from it.
function armOnce(job: Job): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(job.id)) return;

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(job.id, ac);

  void (async (): Promise<void> => {
    while (!ac.signal.aborted) {
      const stored: Job | null | undefined = await jobStore?.get(job.id);
      if (!stored) break;                                  // cancelled while it waited
      job = stored;

      // Suspended ⇒ wait until resumed. Past due — including a fire time that went by while the process
      // was down — runs late rather than expiring silently: `at` refuses a past time at creation.
      const waitMs = job.active === false ? Infinity : Date.parse(job.nextRun) - Date.now();
      if (waitMs <= 0) {
        const run = spawnJob(activeConfigPath!, runSpec(job));
        if (run !== undefined) await finished(run, runSpec(job), ac.signal);
        // Deleted only once the job has finished: a process killed mid-run leaves the request outstanding
        // and it fires again on the next boot, the kinder of the two failures for a one-shot.
        await jobStore?.delete(job.id);
        break;
      }

      const wakeAc = new AbortController();
      sleepControllers.set(job.id, wakeAc);
      await (waitMs === Infinity
        ? sleep(Infinity, ac.signal, wakeAc.signal)
        : sleepUntil(Date.parse(job.nextRun), ac.signal, wakeAc.signal));
      sleepControllers.delete(job.id);
    }

    activeLoops.delete(job.id);
    sleepControllers.delete(job.id);
  })().catch((err: unknown) => {
    process.stderr.write(`[background-jobs] one-shot ${job.id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    activeLoops.delete(job.id);
    sleepControllers.delete(job.id);
  });
}

function armJob(job: Job): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(job.id)) return;

  const { intervalMs } = job;
  if (intervalMs === undefined) { armOnce(job); return; }

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(job.id, ac);

  void (async (): Promise<void> => {
    // Stagger startup: a random delay in [10s, intervalMs], so a restart with several jobs due at once does
    // not fire them in one pulse. Not for a suspended job — it waits indefinitely anyway.
    if (job.active !== false) {
      const startupDelay = intervalMs <= 10_000
        ? intervalMs
        : 10_000 + Math.floor(Math.pow(Math.random(), 2) * (intervalMs - 10_000));
      const wakeAc = new AbortController();
      sleepControllers.set(job.id, wakeAc);
      await sleep(startupDelay, ac.signal, wakeAc.signal);
      sleepControllers.delete(job.id);
    }

    while (!ac.signal.aborted) {
      let stored: Job | null | undefined = await jobStore?.get(job.id);
      if (!stored) break;
      job = stored;

      if (job.active === false) {
        const wakeAc = new AbortController();
        sleepControllers.set(job.id, wakeAc);
        await sleep(Infinity, ac.signal, wakeAc.signal);
        sleepControllers.delete(job.id);
        continue;
      }

      const run = spawnJob(activeConfigPath!, runSpec(job));
      if (run !== undefined) await finished(run, runSpec(job), ac.signal);

      // Re-read: it may have been suspended or edited while it ran.
      stored = await jobStore?.get(job.id);
      if (!stored) break;
      job = stored;

      const now = Date.now();
      const reply = run?.reply();
      job = {
        ...job,
        lastRun: isoAt(now),
        nextRun: isoAt(now + intervalMs),
        version: now.toString(),
        ...(reply !== undefined && reply !== '' ? { lastReply: reply } : {}),
      };
      await jobStore?.set(job.id, job);

      const wakeAc = new AbortController();
      sleepControllers.set(job.id, wakeAc);
      await sleepUntil(Date.now() + intervalMs, ac.signal, wakeAc.signal);
      sleepControllers.delete(job.id);
    }

    activeLoops.delete(job.id);
    sleepControllers.delete(job.id);
  })().catch((err: unknown) => {
    process.stderr.write(`[background-jobs] job ${job.id} loop crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    activeLoops.delete(job.id);
    sleepControllers.delete(job.id);
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

interface BackgroundInput { prompt: string; interval?: string | null; at?: string | null; name?: string; session?: string; provider?: string }

// How late an `at` may already be at CREATION and still be accepted. A model that got the date or the
// year wrong would otherwise fire instantly; refusing names the instant it resolved to.
const AT_PAST_GRACE_MS = 60_000;

type EveryAction =
  | { action: 'list' }
  | { action: 'suspend'; id: string }
  | { action: 'resume';  id: string }
  | { action: 'cancel';  id: string };

function isRunOnce(interval: string | null | undefined): boolean {
  return interval === undefined || interval === null || interval.trim().toLowerCase() === 'once';
}

/** The conversation a new job reports to: the one named, else the one this call is made from — if that
 *  is a real session (a call over HTTP carries a stand-in) — else none. */
async function reportingSession(requested: string | undefined, ctx: ToolContext): Promise<{ session?: string } | { error: string }> {
  const store = machine?.sessions;
  if (store === undefined) return requested === undefined ? {} : { error: 'There are no sessions here to report to.' };
  if (requested !== undefined) {
    return (await store.get(requested)) !== null ? { session: requested } : { error: `Session "${requested}" not found.` };
  }
  return (await store.get(ctx.session.id)) !== null ? { session: ctx.session.id } : {};
}

const backgroundTool: Tool<ToolResultOf<'background_job'>> = {
  name: 'background_job',
  description: `Run a prompt as a job in a detached background process, in one of three timings — pass at most one
timing field:

  neither interval nor at — run once, starting NOW, and return immediately, leaving the job to complete in the background.
  at                      — run once, at the time given. Persists across restarts.
  interval                — run repeatedly, that far apart. Persists across restarts.

Both timed forms return an id: the handle for the background_job_action tool (list / suspend / resume / cancel).
A one-shot deletes itself once it has run.

HOW THE USER HEARS FROM A JOB. Nothing a job replies is shown to anyone. A job tells the user something by
appending a message to a session (session_action append) — by default THIS conversation, or the one
named in \`session\` — where they see it and can follow up with its context. It can also use other tools to, for
example, write workspace files or send emails, if its prompt asks for that. A job with nothing worth
saying ends silently. If the user does not specify where they want the output, you should ask them for clarification.

So write the prompt as an instruction to an agent, saying what to tell the user and when:
  "Remind the user to go to the dentist."
  "Check the token balance. If it is over 50M, tell the user what it is; otherwise say nothing."
A job told only to do something ("check the balance") will do it and tell nobody.

\`at\` is either an ISO-8601 date-time ("2026-08-23T09:00:00Z", or "2026-08-23" for midnight UTC) or a duration
from now ("90m", "2h", "3d") — prefer the duration form when you are unsure of today's date, since a wrong
date is refused rather than run. ALWAYS include the offset on a date-time ("Z", "+01:00"): one without an
offset is resolved in the timezone of the machine matbot runs on, which is not necessarily the user's. The
result echoes the instant it resolved to, so tell the user that time rather than the words you were given. A
time that has already passed is refused; a time that goes by while matbot is not running is honoured late.

\`interval\` is a duration like "30s", "5m", "1h", "24h". Omitting it — or passing "once" or null — is the
run-now form, unless at is given. The job has the same tools and providers as this conversation.

Do not wait for a job's result: tell the user it has started, and that it will report back here.`,
  inputSchema: {
    type:       'object',
    required:   ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The instruction for the job, including what to tell the user and when (see description).' },
      interval: {
        type:        'string',
        description: 'Recurrence gap, e.g. "30s", "5m", "1h", "24h". Omit (or pass "once"/null) to run a single time. Mutually exclusive with "at".',
      },
      at: {
        type:        'string',
        description: 'Run ONCE at this time: an ISO-8601 date-time ("2026-08-23T09:00:00Z") or a duration from now ("90m", "2h", "3d"). Always include the offset ("Z", "+01:00"). Mutually exclusive with "interval". A time already in the past is refused.',
      },
      name: {
        type:        'string',
        description: 'Optional human-readable label: shown in background_job_action (list) and on the messages the job posts.',
      },
      session: {
        type:        'string',
        description: 'Optional: the session id of the conversation the job reports to. Default: this conversation.',
      },
      provider: {
        type:        'string',
        description: 'Provider key to use (e.g. "claude-sonnet-4-6"). Defaults to the provider of the current turn.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext) {
      const { prompt, interval, at, name, session, provider } = input as BackgroundInput;
      // The provider driving this turn, not the config default, unless the call names one.
      const effectiveProvider = provider ?? ctx.provider;
      const timed = typeof at === 'string' && at.trim() !== '';

      if (timed && !isRunOnce(interval)) {
        yield { type: 'error', message: 'Pass "interval" (repeat this often) or "at" (run once, then), not both. For a recurring job that should start at a particular time, schedule a one-shot at that time whose prompt creates the recurring job.' };
        return;
      }

      const reporting = await reportingSession(session, ctx);
      if ('error' in reporting) { yield { type: 'error', message: reporting.error }; return; }
      const target = reporting.session;
      const common = {
        principal: currentPrincipal(),
        ...(name              !== undefined ? { name }                        : {}),
        ...(target            !== undefined ? { session: target }             : {}),
        ...(effectiveProvider !== undefined ? { provider: effectiveProvider } : {}),
      };
      const echoed = {
        ...(name   !== undefined ? { name }            : {}),
        ...(target !== undefined ? { session: target } : {}),
      };

      if (timed) {
        if (!activeConfigPath || !jobStore) {
          yield { type: 'error', message: 'A timed job requires the plugin to be set up with a config path.' };
          return;
        }
        let whenMs: number;
        try { whenMs = parseAt(at!); }
        catch (e) { yield { type: 'error', message: (e as Error).message }; return; }
        const nowMs = Date.now();
        if (whenMs < nowMs - AT_PAST_GRACE_MS) {
          yield { type: 'error', message: `"at" resolved to ${isoAt(whenMs)}, which is in the past (it is now ${isoAt(nowMs)}). Check the date — or, to run the job immediately, call background_job without "at".` };
          return;
        }
        const id = randomUUID();
        const job: OnceJob = {
          id, version: nowMs.toString(), prompt, active: true,
          createdAt: isoAt(nowMs),
          nextRun:   isoAt(whenMs),
          ...common,
        };
        await jobStore.set(job.id, job);
        armJob(job);
        yield { type: 'result', value: { id, at: job.nextRun, ...echoed } };
        return;
      }

      if (isRunOnce(interval)) {
        if (!ctx.configPath) {
          yield { type: 'error', message: 'background requires configPath in context.' };
          return;
        }
        const spec: RunSpec = { id: randomUUID(), prompt, ...common };
        const run = spawnJob(ctx.configPath, spec);
        // Watched to its end for the log only: a run-now job is stored nowhere, so its silence has no row.
        if (run !== undefined) void finished(run, spec, pluginAc?.signal ?? new AbortController().signal);
        yield { type: 'result', value: { status: 'started', ...echoed } };
        return;
      }

      if (!activeConfigPath || !jobStore) {
        yield { type: 'error', message: 'A recurring job requires the plugin to be set up with a config path.' };
        return;
      }
      const iv = interval!.trim();                 // isRunOnce above ruled out undefined / null / "once"
      if (!isDuration(iv)) {
        yield { type: 'error', message: `Invalid interval "${interval}". Use a duration like "30s", "5m", "1h", "24h" — or omit it (or pass "once") to run a single time.` };
        return;
      }
      const intervalMs = durationMs(iv);

      const id    = randomUUID();
      const nowMs = Date.now();
      const job: Job = {
        id, version: nowMs.toString(), prompt, intervalMs, active: true,
        createdAt: isoAt(nowMs),
        nextRun:   isoAt(nowMs + intervalMs),
        ...common,
      };
      await jobStore.set(job.id, job);
      armJob(job);
      yield { type: 'result', value: { id, interval: iv, ...echoed } };
    },
  },
};

// ── background_job_action lifecycle helpers ──────────────────────────────────────────────

async function setActive(id: string, active: boolean): Promise<boolean> {
  const stored = await jobStore?.get(id);
  if (!stored) return false;
  await jobStore?.set(id, { ...stored, active, version: crypto.randomUUID() });
  wakeJob(id);
  return true;
}

async function setActiveAll(active: boolean): Promise<{ ids: string[]; skipped: SkippedJob[] }> {
  const result = await jobStore?.query({});
  const ids: string[] = [];
  const skipped: SkippedJob[] = [];
  for (const doc of result?.items ?? []) {
    if ((doc.active !== false) === active) continue; // already in the target state
    try {
      await jobStore?.set(doc.id, { ...doc, active, version: crypto.randomUUID() });
    } catch (e) {
      // `*` spans the whole store, and a partitioned one holds jobs this principal may read and not write.
      // One refusal is not a refusal of the request: name it and carry on.
      if (!isReadOnlyError(e)) throw e;
      skipped.push({ id: doc.id, kind: 'denied',
        reason: `owned by "${e.owner || 'global'}" and shared in read-only — only its owner can change it` });
      continue;
    }
    wakeJob(doc.id);
    ids.push(doc.id);
  }
  return { ids, skipped };
}

const legacyRows = async (): Promise<LegacyJob[]> =>
  ((await legacyStore?.query({}))?.items ?? []).map(s => ({
    id: s.id, version: s.version, prompt: s.prompt, nextRun: s.nextRun, legacy: true as const,
    ...(s.intervalMs !== undefined ? { intervalMs: s.intervalMs } : {}),
    ...(s.name       !== undefined ? { name: s.name }             : {}),
    ...(s.output     !== undefined ? { output: s.output }         : {}),
  }));

const jobActionTool: Tool<ToolResultOf<'background_job_action'>> = {
  name: 'background_job_action',
  description: `Manage the jobs the background_job tool scheduled for later — recurring ones (created with an interval) and
one-shots (created with an at). A one-shot's row has no intervalMs, its fire time is nextRun, and it disappears
once it has run. A recurring job's lastReply is the end of what it last printed — never shown to the user, but
the place to look when a job that should have reported did not.

ACTIONS
  list    — Show every job with its id, interval, next run time, and active state.
  suspend — Pause a job (preserved, stops running until resumed).
  resume  — Resume a suspended job (runs nearly immediately, then on its interval).
  cancel  — Permanently delete a job. Prefer suspend for a temporary pause.

The id is a job id from 'list' or from the background_job tool. For suspend and resume, pass id "*" to act on ALL
jobs at once. cancel requires a specific id — "*" is not accepted (no bulk delete).

LEGACY ROWS. A row with "legacy": true is a schedule left by the plugin this one replaced. It is listed so it
can be moved, and it is NOT run. Its prompt was written for that plugin, where a job's printed reply was its
result (saved to its "output" file, if it had one); here a job must say what to tell the user. To move one:
create it again with background_job — rewording the prompt to say what to tell the user and when — then cancel the
legacy row. A legacy row cannot be suspended or resumed.

With id "*", \`ids\` is what actually changed and anything left alone is listed under \`skipped\`. Each entry
carries a \`kind\` saying what to do about it — do not read this out of the \`reason\` prose:
  denied      — you may read that job but not write it (owned by another profile and shared in read-only).
  unavailable — the write could not complete this time. Retrying later may well work.`,
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'suspend', 'resume', 'cancel'],
        description: 'list: show all jobs. suspend/resume: pause or re-enable. cancel: permanently delete.',
      },
      id: {
        type:        'string',
        description: 'Job id (suspend/resume/cancel). Use "*" with suspend/resume to act on all; cancel needs a specific id.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, _ctx: ToolContext) {
      const act = input as EveryAction;

      switch (act.action) {
        case 'list': {
          const jobs = (await jobStore?.query({}))?.items ?? [];
          yield { type: 'result', value: [...jobs, ...await legacyRows()] };
          return;
        }

        case 'suspend':
        case 'resume': {
          const active = act.action === 'resume';
          if (act.id === '*') {
            const { ids, skipped } = await setActiveAll(active);
            const report = { count: ids.length, ids, ...(skipped.length > 0 ? { skipped } : {}) };
            yield { type: 'result', value: active ? { resumed: true, ...report } : { suspended: true, ...report } };
            return;
          }
          if (!(await setActive(act.id, active))) {
            const legacy = await legacyStore?.get(act.id);
            yield { type: 'error', message: legacy
              ? `Job ${act.id} is a legacy schedule, which this plugin does not run. Create it again with background_job, then cancel this one.`
              : `Job ${act.id} not found.` };
            return;
          }
          yield { type: 'result', value: active ? { resumed: true, id: act.id } : { suspended: true, id: act.id } };
          return;
        }

        case 'cancel': {
          if (act.id === '*') {
            yield { type: 'error', message: 'cancel requires a specific job id; "*" (all) is not permitted for cancel. Suspend all with { action: "suspend", id: "*" } instead.' };
            return;
          }
          if ((await jobStore?.get(act.id)) == null && (await legacyStore?.get(act.id)) != null) {
            await legacyStore?.delete(act.id);
            yield { type: 'result', value: { cancelled: true, id: act.id, legacy: true } };
            return;
          }
          const ac = activeLoops.get(act.id);
          if (ac) { ac.abort(); activeLoops.delete(act.id); }
          wakeJob(act.id);
          await jobStore?.delete(act.id);
          yield { type: 'result', value: { cancelled: true, id: act.id } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown background_job_action "${(act as { action: string }).action}". Expected one of: list, suspend, resume, cancel.` };
      }
    },
  },
};

// ── The job's side ────────────────────────────────────────────────────────────

// Said to the job's model, which otherwise believes it is talking to the user: a chat model's reply IS
// how it tells someone, and here the reply goes nowhere.
function jobContext(job: JobInfo): string {
  const what  = job.name !== undefined ? `the background job "${job.name}"` : 'a background job';
  const where = job.session !== undefined
    ? `the conversation "${job.sessionTitle ?? 'untitled'}" (session ${job.session})`
    : undefined;
  return [
    `You are running as ${what}. Nothing you reply is shown to anyone.`,
    where !== undefined
      ? `To tell the user something, call session_action with action "append": it posts your text into ${where}, where they will see it and can follow up with its context.`
      : 'This job reports to no conversation. To tell the user something, call session_action with action "append" and name the session to post into.',
    'Use telegram_send only for a bare notification that needs no follow-up, and workspace_action to write files, when the task asks for those.',
    'If there is nothing worth telling the user, end without doing any of these — saying nothing is a normal outcome.',
  ].join(' ');
}

async function setupJob(services: MatbotMachine): Promise<void> {
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
    pluginAc?.signal,
    n => n.kind === ItemChangeKind && n.instance === undefined,
  );
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [backgroundTool, jobActionTool],

  async setup(services: MatbotMachine) {
    pluginAc = new AbortController();
    // A job must not arm a scheduler of its own — that would cascade — but it does need its channel.
    if (services.isSubAgent()) { await setupJob(services); return; }
    machine = services;
    if (!services.configPath) return;
    activeConfigPath = services.configPath;
    jobStore         = services.createStore<Job>('jobs');
    legacyStore      = services.createStore<Omit<LegacyJob, 'legacy'>>(LEGACY_NAMESPACE);
    for (const doc of (await jobStore.query({})).items) armJob(doc);

    const legacy = (await legacyStore.query({})).items.length;
    if (legacy > 0) {
      console.warn(`[background-jobs] ${legacy} schedule(s) left by ${LEGACY_PLUGIN} are not run by this plugin. `
        + 'background_job_action list shows them (marked legacy): re-create each with background_job, then cancel the old one.');
    }
  },

  async teardown() {
    // A job's last announcements are still in the channel when its turn ends; let them go before it exits.
    await parentLink?.flush();
    parentLink       = undefined;
    pluginAc?.abort();
    pluginAc         = undefined;
    activeLoops.clear();
    jobStore         = undefined;
    legacyStore      = undefined;
    activeConfigPath = undefined;
    machine          = undefined;
  },
};

