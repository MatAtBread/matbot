import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolContract, ToolResultOf, ToolContext, Store, Principal,
  AppendMessage, AppendResult,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal, isReadOnlyError, runAs } from '@matatbread/matbot-plugin-api';

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
let machine:          MatbotMachine | undefined;
let pluginAc:         AbortController | undefined;

// ── Running a job ─────────────────────────────────────────────────────────────

/** What a run needs to know about the job it is running, stored or not. */
export interface RunSpec {
  id:         string;
  prompt:     string;
  name?:      string;
  session?:   string;
  provider?:  string;
  principal?: Principal;
}

/** How a run ended, as far as the scheduler cares. */
export interface RunOutcome {
  /** How many messages it appended — 0 is a job that said nothing. */
  appended: number;
  /** The tail of its last reply: never delivered, kept as `lastReply` for a post-mortem. */
  reply:    string;
}

/**
 * Where a job's turn runs — the one thing that differs between this package (in this process) and
 * `matbot-background-jobs-node` (a child process each). Everything else — timings, the store, the tools,
 * where a job reports — is the same either way.
 */
export interface JobRunner {
  /** Run one job to its end; `signal` stops it. `undefined` when it could not be started at all. */
  run(job: RunSpec, signal: AbortSignal): Promise<RunOutcome | undefined>;
}

/** What a specialisation supplies to {@link createBackgroundJobsPlugin}. */
export interface BackgroundJobsHost {
  /** What `plugin list` shows for the package — each specialisation says where its jobs run. */
  description: string;
  /** The runner for this machine, or `undefined` if jobs cannot run here (so no scheduler ticks). */
  runner(machine: MatbotMachine): JobRunner | undefined;
  /** Setup in a process that IS a job (`isSubAgent()`), instead of running a scheduler. */
  inJob?(machine: MatbotMachine, signal: AbortSignal): Promise<void>;
  /** Runs first in teardown — a job's last announcements may still be in flight. */
  teardown?(): Promise<void>;
}

// Kept of what a job says, for `lastReply` and the log — the end, since a reply's last words are its point.
export const REPLY_TAIL = 2_000;

let activeRunner: JobRunner | undefined;

async function runJob(job: RunSpec, signal: AbortSignal): Promise<RunOutcome | undefined> {
  const outcome = await activeRunner?.run(job, signal);
  if (outcome !== undefined && outcome.appended === 0 && outcome.reply !== '') {
    console.warn(`[background-jobs] job ${job.name ?? job.id} ended without reporting. Its last words: ${JSON.stringify(outcome.reply.slice(-300))}`);
  }
  return outcome;
}

/** What a job is told about itself. */
export interface JobInfo {
  id:            string;
  name?:         string;
  /** The conversation the job reports to, and its title — for the job's own context. */
  session?:      string;
  sessionTitle?: string;
}

export async function jobInfo(machine: MatbotMachine, job: RunSpec): Promise<JobInfo> {
  let sessionTitle: string | undefined;
  if (job.session !== undefined && machine.sessions !== undefined) {
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
// here, by the scheduler that knows which job it is, rather than by anything the job says about itself.
export async function appendFor(
  machine: MatbotMachine, job: RunSpec, sessionId: string | undefined, messages: readonly AppendMessage[],
): Promise<AppendResult> {
  const appender = machine.SessionAppender;
  if (appender === undefined) throw new Error('This matbot cannot append to sessions.');
  const target = sessionId ?? job.session;
  if (target === undefined) throw new Error('This job reports to no conversation, so name the session to append to.');
  const labelled = messages.map(m => ({
    ...m, metadata: { job: { id: job.id, ...(job.name !== undefined ? { name: job.name } : {}) } },
  }));
  const append = () => appender.append(target, labelled);
  return job.principal !== undefined ? runAs(job.principal, append) : append();
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Several matbots may share one job store — every open browser tab loads this plugin over the same
// IndexedDB — and each would otherwise arm every stored job, firing it once per tab. There is no leader
// and no lock: THE ROW IS THE SCHEDULE AND `nextRun` IS THE CLAIM. One tick per matbot reads the rows,
// compare-and-swaps the fire time of each job that is due, and runs only what it won. A loser re-reads a
// row that is no longer due and leaves it alone.
//
// Nothing is held, so nothing has to be released and a claimer that dies owes nothing. That also puts a
// job's whole lifecycle in its row, which is what lets a tab write one and another tab run it: creating,
// suspending, resuming and cancelling are row writes, picked up by whichever matbot ticks next.

// wakeSignal shortens the sleep without ending the scheduler (used by every local row write). Listeners
// are detached on every exit: the signals outlive the sleep, so one left behind per call would accumulate
// for the process's life.
function sleep(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || wakeSignal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(id);
      signal.removeEventListener('abort', done);
      wakeSignal?.removeEventListener('abort', done);
      resolve();
    };
    const id = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    wakeSignal?.addEventListener('abort', done, { once: true });
  });
}

// How long after this plugin's setup before a stored job may fire — see the scheduler.
export const BOOT_GRACE_MS = 60_000;

// The longest a tick will sleep, however far off the next job is. This is the window in which a row
// another matbot wrote — a job created, resumed or cancelled in another tab — is picked up here, and it
// replaces a cross-realm wake: there is nothing to notify, because the row already says everything.
// Re-reading every minute is also what absorbs the clock moving under a long wait.
const DISCOVERY_CEILING_MS = 60_000;

// A floor under it, so a tick that found something due but could not claim it cannot spin.
const MIN_SLEEP_MS = 1_000;

// A one-shot's claim pushes its fire time this far out instead of deleting the row (which happens only
// once it has RUN), so a matbot that dies mid-run costs the job its punctuality rather than the request:
// the next tick past the window claims it again. The same preference the delete already stated.
const ONESHOT_RETRY_MS = 300_000;

// The first tick after a restart finds everything that came due while matbot was down, and firing those
// together is the pulse the old per-job startup delay existed to avoid. A recurring job claimed on that
// tick starts at a random point within this window; later ticks need none, since each job then fires at
// its own nextRun. Never a one-shot: its time IS its time.
const BOOT_STAGGER_MS = 10_000;

// One entry per run in flight here, so a cancel can stop it and a run longer than its own interval is not
// started twice. Correctly per-realm: it is this process's runs, not the schedule.
const inFlight = new Map<string, AbortController>();
// Set while the scheduler is sleeping; aborting it brings the next tick forward.
let tickWake: AbortController | undefined;

/**
 * Bring the next tick forward after a local row write — a job created, suspended, resumed or cancelled
 * here — so it takes effect now rather than within the discovery ceiling. Another matbot's write is not
 * seen here at all; the ceiling is what bounds how late that one is picked up.
 */
function nudge(): void {
  const wake = tickWake;
  tickWake = undefined;
  wake?.abort();
}

const runSpec = (job: Job): RunSpec => ({
  id: job.id, prompt: job.prompt,
  ...(job.name      !== undefined ? { name: job.name }           : {}),
  ...(job.session   !== undefined ? { session: job.session }     : {}),
  ...(job.provider  !== undefined ? { provider: job.provider }   : {}),
  ...(job.principal !== undefined ? { principal: job.principal } : {}),
});

/**
 * The first occurrence strictly after `nowMs`, keeping the cadence the job was created on.
 *
 * Advancing by a single interval would leave a job that came due ten intervals ago still due, and the
 * next tick would claim and run it again at once — ten catch-up runs for a machine that was off for a
 * morning. Stamping `nowMs + intervalMs` instead (which is what the old post-run stamp did) slid the
 * schedule by the length of every run.
 */
function nextOccurrence(dueMs: number, intervalMs: number, nowMs: number): number {
  const iv = Math.max(intervalMs, 1);                      // "0s" would otherwise divide by zero
  if (dueMs > nowMs) return dueMs + iv;
  return dueMs + (Math.floor((nowMs - dueMs) / iv) + 1) * iv;
}

/**
 * Take a due job for this matbot by advancing its fire time, and return the row as claimed — or
 * `undefined`, meaning it is not ours to run.
 *
 * A single `cas`, deliberately NOT `mutate`: a lost swap here says another matbot claimed the job (or a
 * suspend landed on it), and re-reading to apply the claim again is exactly the duplicate run this
 * exists to prevent. `lastRun` is stamped with the claim rather than after the run, so a job in flight
 * is distinguishable from one that has never run.
 */
async function claim(job: Job, nowMs: number): Promise<Job | undefined> {
  const store = jobStore;
  if (store === undefined) return undefined;
  const claimed: Job = {
    ...job,
    version: crypto.randomUUID(),
    lastRun: isoAt(nowMs),
    nextRun: job.intervalMs === undefined
      ? isoAt(nowMs + ONESHOT_RETRY_MS)
      : isoAt(nextOccurrence(Date.parse(job.nextRun), job.intervalMs, nowMs)),
  };
  return (await store.cas(job.id, job.version, claimed)).ok ? claimed : undefined;
}

/** Run a job this matbot has claimed, and record what it left behind. */
function start(job: Job, staggerMs: number): void {
  if (!pluginAc) return;

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  inFlight.set(job.id, ac);

  void (async (): Promise<void> => {
    if (staggerMs > 0) await sleep(staggerMs, ac.signal);
    if (ac.signal.aborted) return;

    const outcome = await runJob(runSpec(job), ac.signal);

    if (job.intervalMs === undefined) {
      // Deleted only once the job has RUN. A run that never started at all (no provider to run as, a
      // failed spawn: `undefined`) or one cut short by teardown leaves the row, and its claim window
      // expires it back into a later tick — the kinder of the two failures for a one-shot, since the
      // condition is usually transient. Unconditional: it ran, whatever else landed on the row since.
      if (outcome !== undefined && !ac.signal.aborted) await jobStore?.delete(job.id);
      return;
    }

    const reply = outcome?.reply;
    if (reply !== undefined && reply !== '') {
      // The claim already moved `nextRun`, so this is advisory and composes onto whatever the row says
      // now — a suspend, a resume or a cancel may have landed while the run was in flight. `mutate`
      // rather than `cas`, for exactly the reason the claim is the other way round: losing this costs a
      // post-mortem, not a run.
      await mutate(job.id, current => ({ ...current, lastReply: reply }));
    }
  })()
    .catch((err: unknown) => { console.error(`[background-jobs] job ${job.id} failed:`, err); })
    .finally(() => {
      if (inFlight.get(job.id) === ac) inFlight.delete(job.id);
    });
}

/** One pass over the rows. Returns how long to sleep before the next one. */
async function tick(staggered: boolean): Promise<number> {
  const store = jobStore;
  if (store === undefined) return DISCOVERY_CEILING_MS;

  const nowMs = Date.now();
  let soonest = Infinity;

  for (const job of (await store.query({})).items) {
    // Suspended ⇒ nothing is owed until it is resumed, which is a row write this tick will see.
    if (job.active === false) continue;

    const dueMs = Date.parse(job.nextRun);
    // Past due — including a fire time that went by while matbot was down — runs late rather than
    // expiring silently: `at` refuses a time already past at CREATION, so a stored one was once future.
    if (dueMs > nowMs) { soonest = Math.min(soonest, dueMs); continue; }

    const claimed = await claim(job, nowMs);
    if (claimed === undefined) continue;
    soonest = Math.min(soonest, Date.parse(claimed.nextRun));

    // Still in flight from an earlier occurrence: this one is skipped, not queued, and the claim has
    // already carried the schedule past it — the same gap the old per-job loop left by sleeping a whole
    // interval after each run. A job slower than its own interval would otherwise run back-to-back.
    if (inFlight.has(claimed.id)) continue;

    const stagger = staggered && claimed.intervalMs !== undefined
      ? Math.random() * Math.min(BOOT_STAGGER_MS, claimed.intervalMs)
      : 0;
    start(claimed, stagger);
  }

  return Math.min(soonest - Date.now(), DISCOVERY_CEILING_MS);
}

async function scheduler(signal: AbortSignal): Promise<void> {
  // Stored jobs wait out the boot. Plugins load plugins, so there is no "booted" moment to wait for, and a
  // job past due would otherwise fire while the tools it needs are still arriving. A nudge cuts the wait
  // short, because a nudge only comes from a call made on this machine — which is plainly loaded if
  // something is calling it, the condition the grace was waiting for.
  const bootWake = new AbortController();
  tickWake = bootWake;
  await sleep(BOOT_GRACE_MS, signal, bootWake.signal);
  tickWake = undefined;

  for (let staggered = true; !signal.aborted; staggered = false) {
    let waitMs = DISCOVERY_CEILING_MS;
    try {
      waitMs = await tick(staggered);
    } catch (err) {
      // A store that is briefly unreadable (a backend swapping under us) must not end the scheduler:
      // every job is in a row, so the next tick carries on from wherever this one left off.
      console.error('[background-jobs] scheduler tick failed:', err);
    }
    if (signal.aborted) return;

    const wake = new AbortController();
    tickWake = wake;
    await sleep(Math.max(waitMs, MIN_SLEEP_MS), signal, wake.signal);
    tickWake = undefined;
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

interface BackgroundInput { prompt: string; interval?: string | null; at?: string | null; name?: string; session?: string; provider?: string }

// How late an `at` may already be at CREATION and still be accepted. A model that got the date or the
// year wrong would otherwise fire instantly; refusing names the instant it resolved to.
const AT_PAST_GRACE_MS = 60_000;

const CANNOT_RUN = 'Background jobs cannot run in this matbot: no job runner could be set up here (see its log).';

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
  description: `Run a prompt as a background job, in one of three timings — pass at most one
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
        if (!activeRunner || !jobStore) {
          yield { type: 'error', message: CANNOT_RUN };
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
        const id = crypto.randomUUID();
        const job: OnceJob = {
          id, version: nowMs.toString(), prompt, active: true,
          createdAt: isoAt(nowMs),
          nextRun:   isoAt(whenMs),
          ...common,
        };
        await jobStore.set(job.id, job);
        nudge();                                 // the row is the schedule; the tick picks it up
        yield { type: 'result', value: { id, at: job.nextRun, ...echoed } };
        return;
      }

      if (isRunOnce(interval)) {
        if (!activeRunner) {
          yield { type: 'error', message: CANNOT_RUN };
          return;
        }
        const spec: RunSpec = { id: crypto.randomUUID(), prompt, ...common };
        // Not awaited: the call returns at once and the job reports for itself. Watched to its end for the
        // log only — a run-now job is stored nowhere, so its silence has no row.
        void runJob(spec, pluginAc?.signal ?? new AbortController().signal)
          .catch((err: unknown) => { console.error(`[background-jobs] job ${spec.id} failed:`, err); });
        yield { type: 'result', value: { status: 'started', ...echoed } };
        return;
      }

      if (!activeRunner || !jobStore) {
        yield { type: 'error', message: CANNOT_RUN };
        return;
      }
      const iv = interval!.trim();                 // isRunOnce above ruled out undefined / null / "once"
      if (!isDuration(iv)) {
        yield { type: 'error', message: `Invalid interval "${interval}". Use a duration like "30s", "5m", "1h", "24h" — or omit it (or pass "once") to run a single time.` };
        return;
      }
      const intervalMs = durationMs(iv);

      const id    = crypto.randomUUID();
      const nowMs = Date.now();
      const job: Job = {
        id, version: nowMs.toString(), prompt, intervalMs, active: true,
        createdAt: isoAt(nowMs),
        nextRun:   isoAt(nowMs + intervalMs),
        ...common,
      };
      await jobStore.set(job.id, job);
      nudge();                                   // the row is the schedule; the tick picks it up
      yield { type: 'result', value: { id, interval: iv, ...echoed } };
    },
  },
};

// ── background_job_action lifecycle helpers ──────────────────────────────────────────────

/**
 * Change one job row under compare-and-swap.
 *
 * Every writer of a row is a read-modify-write and they race each other: a run recording its `lastReply`,
 * a `suspend` flipping `active`, a `cancel` deleting it. A plain `set` let whichever landed last win over a
 * document it had never read — a suspend overwritten by the stamp that followed it, and a cancelled row
 * RECREATED by that stamp, to be run again on the next boot. So each writer re-reads, applies its change to
 * what it finds and swaps on that version; a loss means another writer got there, and reading again composes
 * with it instead of erasing it.
 *
 * `claim` is the one writer that does NOT retry, for the opposite reason: there, a lost swap means another
 * matbot took the job.
 *
 * `gone` is distinct from `contended` because the callers act on it: a cancelled row is the tool's cue to
 * say the job does not exist, and a run's cue that there is nothing left to record against. A `set`
 * reported neither.
 */
type Written =
  | { done: true;  job: Job }
  | { done: false; kind: 'gone' | 'contended' };

const JOB_WRITE_ATTEMPTS = 3;

async function mutate(id: string, change: (job: Job) => Job): Promise<Written> {
  const store = jobStore;
  if (store === undefined) return { done: false, kind: 'gone' };
  for (let n = 0; n < JOB_WRITE_ATTEMPTS; n++) {
    const current = await store.get(id);
    if (!current) return { done: false, kind: 'gone' };
    const next: Job = { ...change(current), version: crypto.randomUUID() };
    // A read-only refusal is the caller's to classify (see setActiveAll), so it is left to propagate.
    if ((await store.cas(id, current.version, next)).ok) return { done: true, job: next };
  }
  return { done: false, kind: 'contended' };
}

async function setActive(id: string, active: boolean): Promise<Written> {
  const written = await mutate(id, job => ({ ...job, active }));
  if (written.done) nudge();
  return written;
}

async function setActiveAll(active: boolean): Promise<{ ids: string[]; skipped: SkippedJob[] }> {
  const result = await jobStore?.query({});
  const ids: string[] = [];
  const skipped: SkippedJob[] = [];
  for (const doc of result?.items ?? []) {
    if ((doc.active !== false) === active) continue; // already in the target state
    try {
      const written = await setActive(doc.id, active);
      // Gone means cancelled since the query — nothing was asked of it and nothing is owed about it.
      if (!written.done) {
        if (written.kind === 'contended') {
          skipped.push({ id: doc.id, kind: 'unavailable',
            reason: 'it is being written concurrently (a run of it is starting or finishing) — asking again should work' });
        }
        continue;
      }
    } catch (e) {
      // `*` spans the whole store, and a partitioned one holds jobs this principal may read and not write.
      // One refusal is not a refusal of the request: name it and carry on.
      if (!isReadOnlyError(e)) throw e;
      skipped.push({ id: doc.id, kind: 'denied',
        reason: `owned by "${e.owner || 'global'}" and shared in read-only — only its owner can change it` });
      continue;
    }
    ids.push(doc.id);                                      // woken by setActive, which made the write
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
once it has run. A job with a lastRun and a nextRun in the future may be running right now: nextRun is moved
forward when a run starts, so that no other matbot sharing this store runs the same job at the same time. A recurring job's lastReply is the end of what it last printed — never shown to the user, but
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
          const written = await setActive(act.id, active);
          if (!written.done) {
            // Contended is not "not found": the row is there and its own run is stamping it.
            if (written.kind === 'contended') {
              yield { type: 'error', message: `Job ${act.id} is being written concurrently (a run of it is starting or finishing) — ask again.` };
              return;
            }
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
          // Stop a run of it in flight HERE; one in flight in another matbot ends when it ends, and
          // finds the row gone when it goes to write what it left behind.
          const ac = inFlight.get(act.id);
          if (ac) { ac.abort(); inFlight.delete(act.id); }
          await jobStore?.delete(act.id);
          nudge();
          yield { type: 'result', value: { cancelled: true, id: act.id } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown background_job_action "${(act as { action: string }).action}". Expected one of: list, suspend, resume, cancel.` };
      }
    },
  },
};

// ── The job's context ─────────────────────────────────────────────────────────

// Said to the job's model, which otherwise believes it is talking to the user: a chat model's reply IS
// how it tells someone, and here the reply goes nowhere.
export function jobContext(job: JobInfo): string {
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

// ── Plugin ────────────────────────────────────────────────────────────────────

/**
 * The plugin, given where its jobs run. This package's own `plugin` runs them in this process; the node
 * specialisation passes a runner that spawns a process per job, and the setup a job's process needs.
 */
export function createBackgroundJobsPlugin(host: BackgroundJobsHost): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest:   { description: host.description },
    tools: [backgroundTool, jobActionTool],

    async setup(services: MatbotMachine) {
      pluginAc = new AbortController();
      // A job must not run a scheduler of its own — that would cascade.
      if (services.isSubAgent()) { await host.inJob?.(services, pluginAc.signal); return; }
      machine      = services;
      activeRunner = host.runner(services);
      jobStore     = services.createStore<Job>('jobs');
      legacyStore  = services.createStore<Omit<LegacyJob, 'legacy'>>(LEGACY_NAMESPACE);

      const legacy = (await legacyStore.query({})).items.length;
      if (legacy > 0) {
        console.warn(`[background-jobs] ${legacy} schedule(s) left by ${LEGACY_PLUGIN} are not run by this plugin. `
          + 'background_job_action list shows them (marked legacy): re-create each with background_job, then cancel the old one.');
      }
      if (activeRunner === undefined) return;

      // Not awaited: it ticks for this plugin's whole load extent.
      void scheduler(pluginAc.signal)
        .catch((err: unknown) => { console.error('[background-jobs] scheduler stopped:', err); });
    },

    async teardown() {
      await host.teardown?.();
      pluginAc?.abort();
      pluginAc     = undefined;
      tickWake     = undefined;
      inFlight.clear();
      jobStore     = undefined;
      legacyStore  = undefined;
      activeRunner = undefined;
      machine      = undefined;
    },
  };
}
