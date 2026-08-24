import { spawn, type ChildProcess } from 'node:child_process';
import { execArgv, argv, execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync }       from 'node:fs';
import { pathToFileURL }    from 'node:url';
import { randomUUID }       from 'node:crypto';
import type { Readable }    from 'node:stream';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext, FileStore, Store, Principal,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal, ItemChangeKind, isReadOnlyError } from '@matatbread/matbot-plugin-api';

// Why a schedule was left alone, split the way a caller has to act on it — the 4xx/5xx distinction.
// `denied` will be refused again however many times it is asked; `unavailable` may succeed later. `reason`
// is the prose; branch on `kind`, never on the prose. Kept local rather than shared with edit-session's
// identical shape: two plugins agreeing on three words is not yet an abstraction worth a package.
type SkipKind = 'denied' | 'unavailable';
interface SkippedSchedule { id: string; kind: SkipKind; reason: string }

/**
 * The two string shapes this tool accepts, as types rather than as prose in a description.
 *
 * They are the validation regexes below, restated where a caller can be held to them: a composed
 * function passing `interval: 'once a day'` or `at: 'tomorrow'` is a compile error rather than a tool
 * error at run time, and the model reads the accepted shape off the rendered params instead of having to
 * find the sentence about it. Deliberately approximate at the edges — `${number}` also admits `-5s` and
 * `1e3s`, and a date is not checked for a real month — because the executor validates regardless and a
 * type that rejects the mistakes people actually make has earned its keep. The correspondence between
 * each regex and its type is asserted in exactly one place: `isDuration` for one, `isoAt` for the other.
 */
type Duration   = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;
// Spelled out rather than composed from an `IsoDate` alias: the dts bundler inlines a referenced type,
// and the nested form (`${`${number}-${number}-${number}`}T${string}`) is what the model would then read
// off the rendered params.
type IsoInstant = `${number}-${number}-${number}` | `${number}-${number}-${number}T${string}`;

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // `background` discriminates on which timing field is present, not an `action` field: `interval` is
    // a recurring schedule, `at` a single run at a stated time, neither a single run starting now. Each
    // arm requires its own field, so no two overlap.
    background:
      | ToolContract<{ id: string; interval: Duration; name?: string }, { prompt: string; interval: Duration; name?: string; output?: string; provider?: string }>          // recurring (id is the handle)
      | ToolContract<{ id: string; at: IsoInstant; name?: string }, { prompt: string; at: Duration | IsoInstant; name?: string; output?: string; provider?: string }>        // timed one-shot (given either way, always echoed as the resolved instant)
      | ToolContract<{ status: 'started'; output?: string }, { prompt: string; interval?: 'once' | null; output?: string; provider?: string }>;                              // run-once, now (the sentinels mean "no interval")
    // `every_action` discriminates on `action`; resume/suspend results further split on whether id is "*"
    // (all) vs a single id, which a caller can't predeclare, so each keeps its two-shape result union.
    every_action:
      // `interval` reads "once" for a one-shot (the same sentinel `background` accepts), so one row shape
      // covers both kinds and `nextRun` is the fire time in either.
      | ToolContract<Array<{ id: string; interval: Duration | 'once'; nextRun: IsoInstant; active: boolean; name?: string; lastRun?: IsoInstant; output?: string }>, { action: 'list' }>
      // `skipped` appears only when the sweep met a schedule it could not write (one shared in read-only):
      // "all" that silently wasn't all is the failure the field reported one namespace over.
      | ToolContract<{ resumed:   true; count: number; ids: string[]; skipped?: SkippedSchedule[] } | { resumed:   true; id: string }, { action: 'resume';  id: string }>
      | ToolContract<{ suspended: true; count: number; ids: string[]; skipped?: SkippedSchedule[] } | { suspended: true; id: string }, { action: 'suspend'; id: string }>
      | ToolContract<{ cancelled: true; id: string }, { action: 'cancel'; id: string }>;
  }
}

// ── MIME helpers ──────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
};

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot !== -1 ? name.slice(dot).toLowerCase() : '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ── Duration helpers ──────────────────────────────────────────────────────────

const DURATION_FACTORS: Record<string, number> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** The one place the duration regex and the `Duration` type are equated — a value typed `Duration`
 *  anywhere else got there by passing through here, so nothing is cast on faith. */
function isDuration(s: string): s is Duration { return DURATION_RE.test(s.trim()); }

/** Takes a `Duration`, so it cannot fail: the shape was established by {@link isDuration}, which is what
 *  lets each caller word its own refusal (an interval and an `at` are wrong in different ways). */
function durationMs(d: Duration): number {
  const m = DURATION_RE.exec(d.trim())!;
  return parseFloat(m[1]!) * (DURATION_FACTORS[m[2]!] ?? 1);
}

// `toISOString()` returns exactly `IsoInstant` by specification; this is the one place that is asserted,
// so every date a Schedule carries has a shape a caller can rely on rather than being a bare string.
const isoAt = (ms: number): IsoInstant => new Date(ms).toISOString() as IsoInstant;

// Absolute instant or duration-from-now, both accepted: a model asked for "in two hours" can answer
// that without knowing today's date, and one asked for "09:00 tomorrow" needs the absolute form. The
// duration grammar is `interval`'s. A bare number is rejected rather than left to Date.parse, which
// reads "5" as a year — the one failure mode that fires at a plausible-looking wrong time.
const AT_ABSOLUTE = /^\d{4}-\d{2}-\d{2}/;

/**
 * `Date.parse` splits the absolute form on a detail worth stating rather than papering over. A
 * DATE-ONLY `at` ("2026-08-23") is midnight **UTC** by spec; a date-time with **no offset**
 * ("2026-08-23T09:00:00") is **local** — so the two differ by up to a day's worth of offset, and
 * `AT_PAST_GRACE_MS` cannot catch it because the drift goes forward as often as back.
 *
 * And "local" is the HOST's zone, not the asker's. Under the node CLI or server that is the machine
 * matbot runs on, which is very often not where the person is — a schedule they meant for 09:00 lands
 * at the server's 09:00. In the web bundle the host IS the browser, so there it genuinely is their own
 * zone. Same string, two different instants depending on which host created the schedule.
 *
 * Left as it is rather than normalised: forcing the offset-less form to UTC would silently move an
 * appointment a browser-hosted user meant locally, and honouring the asker's zone needs a carrier this
 * plugin has no access to. So the answer is to give an explicit offset (`Z`, `+01:00`), and the tool
 * description says so — the only place a model will read it.
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

function formatDuration(ms: number): Duration {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000  === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000     === 0) return `${ms / 60_000}m`;
  if (ms % 1_000      === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

// ── Schedule types & storage ──────────────────────────────────────────────────

interface ScheduleBase {
  id:         string;
  version:    string;
  prompt:     string;
  createdAt:  IsoInstant;
  /** When this schedule next fires. For a one-shot it is the only time it ever fires. */
  nextRun:    IsoInstant;
  active?:    boolean;
  name?:      string;
  output?:    string;
  lastRun?:   IsoInstant;
  provider?:  string;
  // Creator identity, captured at creation and replayed each fire so a recurring job runs as the
  // user who scheduled it. Absent on legacy rows ⇒ the child falls back to its own boot default.
  principal?: Principal;
}

/** Fires every `intervalMs` until suspended or cancelled. */
interface EverySchedule extends ScheduleBase { intervalMs: number }
/** Fires once, at `nextRun`, and deletes itself. No `oneShot` flag: the ABSENCE of an interval is
 *  what makes it one, exactly as it is on the `background` tool's own parameters — a separate flag
 *  could disagree with the interval beside it, and nothing would say which was meant. */
interface OnceSchedule  extends ScheduleBase { intervalMs?: undefined }

type Schedule = EverySchedule | OnceSchedule;

let scheduleStore:   Store<Schedule> | undefined;
let activeConfigPath: string | undefined;
let activeFiles:     FileStore | undefined;
// Set in setup(); announces a finished job's captured output file. No-op before setup.
let notifyOutput: ((id: string, principal: Principal | undefined, name: string) => void) | undefined;
let pluginAc:        AbortController | undefined;
const activeLoops    = new Map<string, AbortController>();
// One entry per schedule while it is sleeping; aborting it wakes the sleep early.
const sleepControllers = new Map<string, AbortController>();

// ── Spawn helpers ─────────────────────────────────────────────────────────────

// When true, background jobs run in a new process group and survive the parent exiting.
// When false, they are tied to the parent's process group.
const DETACH_BACKGROUND_JOBS = false;

// Relative path args (--import, --require, --loader) resolve against the CWD at
// launch time, which may differ from dirname(argv[1]). Walk up from the script
// directory until we find the file, then emit a file:// URL so the child resolves
// it correctly regardless of its own CWD.
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
  const escapedPath = configPath.replace(/'/g, "''");
  const indented    = prompt.split('\n').map(l => '  ' + l).join('\n');
  const providerLine = provider !== undefined ? `default_provider: '${provider.replace(/'/g, "''")}'\n` : '';
  return `extends: '${escapedPath}'\nephemeral: true\n${providerLine}prompt: |\n${indented}\n`;
}

async function* stdoutStream(readable: Readable): AsyncIterable<Uint8Array> {
  for await (const chunk of readable) yield chunk as Uint8Array;
}

function spawnJob(configPath: string, prompt: string, output?: string, files?: FileStore, provider?: string, principal?: Principal): ChildProcess | undefined {
  const script = argv[1];
  if (script === undefined) return undefined;

  const captureOut = output !== undefined && files !== undefined;
  const child = spawn(
    execPath,
    [...absoluteExecArgv(script), script, '--config', '-'],
    {
      detached: DETACH_BACKGROUND_JOBS,
      stdio:    ['pipe', captureOut ? 'pipe' : 'ignore', 'inherit'],
      // The env channel carries process identity/mode; the piped config (stdin) carries the task.
      // IS_SUB_AGENT prevents the background plugin in the child from arming its own scheduler loop,
      // which would cascade exponentially. MATBOT_PRINCIPAL delegates the creator's identity so the
      // job runs as them — overriding any identity this parent inherited (e.g. a pod default).
      env: {
        ...process.env,
        IS_SUB_AGENT: '1',
        ...(principal !== undefined ? { MATBOT_PRINCIPAL: JSON.stringify(principal) } : {}),
      },
    },
  );

  if (!child.stdin) return undefined;
  child.stdin.write(buildJobConfig(configPath, prompt, provider));
  child.stdin.end();

  if (captureOut && child.stdout !== null && output !== undefined && files !== undefined) {
    files.put(output, mimeFromName(output), stdoutStream(child.stdout), { namespace: 'workspace', allowed: true })
      // The parent owns this write (it pipes the detached child's stdout), so completion is observable
      // here — the file landing IS the job finishing. Announced explicitly rather than left to the file
      // store's own watch, which not every backend has and which cannot say who the job ran as.
      .then(handle => notifyOutput?.(handle.id, principal, output))
      .catch((err: unknown) => process.stderr.write(
        `[background] output capture failed for "${output}": ${err instanceof Error ? err.message : String(err)}\n`,
      ));
  }

  child.unref();
  return child;
}

// ── Scheduler loop ────────────────────────────────────────────────────────────

// wakeSignal interrupts the sleep without killing the loop (used by suspend/resume).
// Pass Infinity for ms to sleep until one of the signals fires.
function sleep(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || wakeSignal?.aborted) { resolve(); return; }
    // Detached on EVERY exit, including the ordinary timeout. `{ once: true }` only covers the abort
    // path, and these signals outlive the sleep by design — `signal` lives as long as the schedule's
    // loop — so a listener left behind per call accumulates for the process's life: one per interval
    // fire, and now one per 24.8-day chunk of a single long `sleepUntil` wait. That is the
    // MaxListenersExceededWarning, plus a retained closure behind each one.
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

// setTimeout takes a 32-bit signed delay: hand it more and it fires IMMEDIATELY (node warns and clamps
// to 1ms), so a wait longer than ~24.8 days becomes a tight loop rather than a long sleep — "remind me
// next year" spinning at full speed against the store. A long wait is therefore slept in chunks against
// its deadline, which is also the only form that survives the clock moving under it.
const MAX_TIMEOUT_MS = 2_147_483_647;

async function sleepUntil(deadlineMs: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0 || signal.aborted || wakeSignal?.aborted === true) return;
    await sleep(Math.min(remaining, MAX_TIMEOUT_MS), signal, wakeSignal);
  }
}

function wakeSchedule(id: string): void {
  const wakeAc = sleepControllers.get(id);
  if (wakeAc) { sleepControllers.delete(id); wakeAc.abort(); }
}

// A single run at a stated time. Kept apart from the recurring loop rather than folded into it: it has
// no interval to sleep, no stagger (its time IS its time, so spreading it would move the appointment),
// and it ends by deleting itself — three of the recurring loop's four decisions inverted.
function armOnce(sched: Schedule): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(sched.id)) return;

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(sched.id, ac);

  void (async (): Promise<void> => {
    // Re-read on every pass, like the recurring loop: suspend/resume and cancel both land in the store,
    // and this loop learns of them only by reading it again after being woken.
    while (!ac.signal.aborted) {
      const stored: Schedule | null | undefined = await scheduleStore?.get(sched.id);
      if (!stored) break;                                  // cancelled while it waited
      sched = stored;

      // Suspended ⇒ wait indefinitely (every_action resume wakes it). A one-shot whose time passed
      // while it was suspended fires as soon as it is resumed, by the same rule as below.
      const waitMs = sched.active === false ? Infinity : Date.parse(sched.nextRun) - Date.now();
      // Past due — including a fire time that went by while the process was down. A one-shot is a
      // request that stays true until it is honoured, so it runs late rather than expiring silently;
      // `at` refuses a time already past at creation, so a late fire is only ever a real one.
      if (waitMs <= 0) {
        const child = spawnJob(activeConfigPath!, sched.prompt, sched.output, activeFiles, sched.provider, sched.principal);
        if (child !== undefined) {
          const killChild = () => { child.kill(); };
          ac.signal.addEventListener('abort', killChild, { once: true });
          await new Promise<void>(r => child.once('exit', () => {
            ac.signal.removeEventListener('abort', killChild);
            r();
          }));
        }
        // Deleted only once the job has finished, mirroring the recurring loop's post-exit write: a
        // process killed mid-run leaves the request outstanding and it fires again on the next boot,
        // which for a one-shot is the kinder of the two failures.
        await scheduleStore?.delete(sched.id);
        break;
      }

      const wakeAc = new AbortController();
      sleepControllers.set(sched.id, wakeAc);
      await (waitMs === Infinity
        ? sleep(Infinity, ac.signal, wakeAc.signal)              // suspended: until resumed
        : sleepUntil(Date.parse(sched.nextRun), ac.signal, wakeAc.signal));
      sleepControllers.delete(sched.id);
    }

    activeLoops.delete(sched.id);
    sleepControllers.delete(sched.id);
  })().catch((err: unknown) => {
    process.stderr.write(
      `[background] one-shot ${sched.id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    activeLoops.delete(sched.id);
    sleepControllers.delete(sched.id);
  });
}

function armSchedule(sched: Schedule): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(sched.id)) return;

  // The absence of an interval is what makes a schedule a one-shot, so this is the dispatch every
  // caller goes through — boot's sweep and the tool both hand over a Schedule without knowing which.
  const { intervalMs } = sched;
  if (intervalMs === undefined) { armOnce(sched); return; }

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(sched.id, ac);

  void (async (): Promise<void> => {
    // Stagger startup: random delay in [10s, intervalMs] to avoid a pulse when
    // the process restarts with multiple schedules all due at the same time.
    // Skip the stagger for suspended schedules — they'll wait indefinitely anyway.
    if (sched.active !== false) {
      const startupDelay = intervalMs <= 10_000
        ? intervalMs
        : 10_000 + Math.floor(Math.pow(Math.random(), 2) * (intervalMs - 10_000));
      const wakeAc = new AbortController();
      sleepControllers.set(sched.id, wakeAc);
      await sleep(startupDelay, ac.signal, wakeAc.signal);
      sleepControllers.delete(sched.id);
    }

    while (!ac.signal.aborted) {
      // Reload from store so suspend/resume state changes are picked up.
      let stored: Schedule | null | undefined = await scheduleStore?.get(sched.id);
      if (!stored) break;
      sched = stored;

      if (sched.active === false) {
        // Suspended: wait indefinitely until woken by every_action (resume).
        const wakeAc = new AbortController();
        sleepControllers.set(sched.id, wakeAc);
        await sleep(Infinity, ac.signal, wakeAc.signal);
        sleepControllers.delete(sched.id);
        continue;
      }

      const child = spawnJob(activeConfigPath!, sched.prompt, sched.output, activeFiles, sched.provider, sched.principal);
      if (child !== undefined) {
        const killChild = () => { child.kill(); };
        ac.signal.addEventListener('abort', killChild, { once: true });
        await new Promise<void>(r => child.once('exit', () => {
          ac.signal.removeEventListener('abort', killChild);
          r();
        }));
      }

      // We need to get the state again in case it changed while the job was running, e.g. if the user suspended it manually or if another instance of the loop updated the nextRun time after a restart.
      stored = await scheduleStore?.get(sched.id);
      if (!stored) break;
      sched = stored;

      const now = Date.now();
      sched.lastRun = isoAt(now);
      sched.nextRun = isoAt(now + intervalMs);
      sched.version = now.toString();
      await scheduleStore?.set(sched.id, sched);

      const wakeAc = new AbortController();
      sleepControllers.set(sched.id, wakeAc);
      await sleepUntil(Date.now() + intervalMs, ac.signal, wakeAc.signal);
      sleepControllers.delete(sched.id);
    }

    activeLoops.delete(sched.id);
    sleepControllers.delete(sched.id);
  })().catch((err: unknown) => {
    process.stderr.write(
      `[background] schedule ${sched.id} loop crashed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    activeLoops.delete(sched.id);
    sleepControllers.delete(sched.id);
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

interface BackgroundInput { prompt: string; interval?: string | null; at?: string | null; name?: string; output?: string; provider?: string; }

// How late an `at` may already be at CREATION and still be accepted. A model that got the date or the
// year wrong would otherwise fire instantly, which reads as the tool having ignored the time it was
// given; refusing names the instant it resolved to, so the mistake is visible. This is unrelated to a
// fire time missed while the process was down — that one is honoured late (see armOnce).
const AT_PAST_GRACE_MS = 60_000;

type EveryAction =
  | { action: 'list' }
  | { action: 'suspend'; id: string }
  | { action: 'resume';  id: string }
  | { action: 'cancel';  id: string };

// "Run once" sentinels accepted in place of omitting interval entirely.
function isRunOnce(interval: string | null | undefined): boolean {
  return interval === undefined || interval === null || interval.trim().toLowerCase() === 'once';
}

const backgroundTool: Tool<ToolResultOf<'background'>> = {
  name: 'background',
  description: `Run a prompt in a detached background process, in one of three timings — pass at most one
timing field:

  neither interval nor at — run once, starting NOW, and return immediately.
  at                      — run once, at the time given. Persists across restarts.
  interval                — run repeatedly, that far apart. Persists across restarts.

Both timed forms return an id: the handle for the every_action tool (list / suspend / resume / cancel).
A one-shot deletes itself once it has run, so it stops appearing in every_action list.

at is either an ISO-8601 date-time ("2026-08-23T09:00:00Z", or "2026-08-23" for midnight UTC) or a
duration from now ("90m", "2h", "3d") — prefer the duration form when you are unsure of today's date,
since a wrong date is refused rather than run. ALWAYS include the offset on a date-time ("Z", "+01:00"):
one without an offset is resolved in the timezone of the machine matbot runs on, which is not
necessarily the user's, so "09:00" can land hours from where they meant it. The result echoes the instant it resolved to, so tell the
user that time rather than the words you were given. A time that has already passed is refused; a time
that goes by while matbot is not running is honoured late, on the next start.

A job that runs while nobody is watching leaves no trace unless you name an output file: that file
appearing in the workspace IS how the user finds out it ran, so name one for anything whose result
matters.

interval is a duration like "30s", "5m", "1h", "24h". Omitting it — or passing "once" or null — is the
run-now form, unless at is given.

The background process has access to the same tools and providers. Optionally name a workspace
file to capture the process's stdout; without an output file, stdout is discarded.

When the user asks for something in the background, do not wait for the output — notify them the
task has started (and the output filename, if any); they will check the result themselves later.

When running a task in the background, don't wait for the result - the user will be notified. If they
wanted to see the result, they would have asked for it in the foreground.
`,
  inputSchema: {
    type:       'object',
    required:   ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The task for the background process to carry out.' },
      interval: {
        type:        'string',
        description: 'Recurrence gap, e.g. "30s", "5m", "1h", "24h". Omit (or pass "once"/null) to run a single time. Mutually exclusive with "at".',
      },
      at: {
        type:        'string',
        description: 'Run ONCE at this time: an ISO-8601 date-time ("2026-08-23T09:00:00Z") or a duration from now ("90m", "2h", "3d"). Always include the offset ("Z", "+01:00") — a date-time without one is read in the host machine\'s timezone, not the user\'s. Mutually exclusive with "interval". A time already in the past is refused.',
      },
      name: {
        type:        'string',
        description: 'Timed or recurring only: optional human-readable label shown in every_action (list).',
      },
      output: {
        type:        'string',
        description: 'Optional workspace filename to capture stdout into (e.g. "summary.md"). If omitted, stdout is discarded.',
      },
      provider: {
        type:        'string',
        description: 'Provider key to use (e.g. "claude-sonnet-4-6"). Defaults to the provider of the current turn.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext) {
      const { prompt, interval, at, name, output, provider } = input as BackgroundInput;
      // Default to the provider driving this turn, not the config default — a background task
      // inherits the model that spawned it unless the tool call names one explicitly.
      const effectiveProvider = provider ?? ctx.provider;
      const timed = typeof at === 'string' && at.trim() !== '';

      if (timed && !isRunOnce(interval)) {
        yield { type: 'error', message: 'Pass "interval" (repeat this often) or "at" (run once, then), not both. For a recurring job that should start at a particular time, schedule a one-shot at that time whose prompt creates the recurring job.' };
        return;
      }

      if (timed) {
        if (!activeConfigPath || !scheduleStore) {
          yield { type: 'error', message: 'A timed background job requires the plugin to be set up with a config path.' };
          return;
        }
        let whenMs: number;
        try { whenMs = parseAt(at!); }
        catch (e) { yield { type: 'error', message: (e as Error).message }; return; }
        const nowMs = Date.now();
        if (whenMs < nowMs - AT_PAST_GRACE_MS) {
          yield { type: 'error', message: `"at" resolved to ${isoAt(whenMs)}, which is in the past (it is now ${isoAt(nowMs)}). Check the date — or, to run the job immediately, call background without "at".` };
          return;
        }
        const id = randomUUID();
        const sched: OnceSchedule = {
          id, version: nowMs.toString(), prompt, active: true,
          createdAt: isoAt(nowMs),
          nextRun:   isoAt(whenMs),
          principal: currentPrincipal(),
          ...(name              !== undefined ? { name              } : {}),
          ...(output            !== undefined ? { output            } : {}),
          ...(effectiveProvider !== undefined ? { provider: effectiveProvider } : {}),
        };
        await scheduleStore.set(sched.id, sched);
        armSchedule(sched);
        yield { type: 'result', value: { id, at: sched.nextRun, ...(name !== undefined ? { name } : {}) } };
        return;
      }

      if (isRunOnce(interval)) {
        if (!ctx.configPath) {
          yield { type: 'error', message: 'background requires configPath in context.' };
          return;
        }
        spawnJob(ctx.configPath, prompt, output, ctx.files, effectiveProvider, currentPrincipal());
        yield { type: 'result', value: { status: 'started', ...(output !== undefined ? { output } : {}) } };
        return;
      }

      if (!activeConfigPath || !scheduleStore) {
        yield { type: 'error', message: 'A recurring background job requires the plugin to be set up with a config path.' };
        return;
      }
      // Narrowed rather than parsed-and-caught: the type IS the regex (see `Duration`), so a value that
      // survives this line can be echoed back in the result without a cast, and this caller words its own
      // refusal — an interval and an `at` are wrong in different ways and deserve different sentences.
      const iv = interval!.trim();                 // isRunOnce above ruled out undefined / null / "once"
      if (!isDuration(iv)) {
        yield { type: 'error', message: `Invalid interval "${interval}". Use a duration like "30s", "5m", "1h", "24h" — or omit it (or pass "once") to run a single time.` };
        return;
      }
      const intervalMs = durationMs(iv);

      const id    = randomUUID();
      const nowMs = Date.now();
      const sched: Schedule = {
        id, version: nowMs.toString(), prompt, intervalMs, active: true,
        createdAt: isoAt(nowMs),
        nextRun:   isoAt(nowMs + intervalMs),
        principal: currentPrincipal(),
        ...(name              !== undefined ? { name              } : {}),
        ...(output            !== undefined ? { output            } : {}),
        ...(effectiveProvider !== undefined ? { provider: effectiveProvider } : {}),
      };
      await scheduleStore.set(sched.id, sched);
      armSchedule(sched);
      yield { type: 'result', value: { id, interval: iv, ...(name !== undefined ? { name } : {}) } };
    },
  },
};

// ── every_action lifecycle helpers ──────────────────────────────────────────────

async function setActive(id: string, active: boolean): Promise<boolean> {
  const stored = await scheduleStore?.get(id);
  if (!stored) return false;
  await scheduleStore?.set(id, { ...stored, active, version: Date.now().toString() });
  wakeSchedule(id);
  return true;
}

async function setActiveAll(active: boolean): Promise<{ ids: string[]; skipped: SkippedSchedule[] }> {
  const result = await scheduleStore?.query({});
  const ids: string[] = [];
  const skipped: SkippedSchedule[] = [];
  for (const doc of result?.items ?? []) {
    if ((doc.active !== false) === active) continue; // already in the target state
    try {
      await scheduleStore?.set(doc.id, { ...doc, active, version: Date.now().toString() });
    } catch (e) {
      // `*` spans the whole store, and a partitioned one holds schedules this principal may read and not
      // write. One refusal is not a refusal of the request: name it and carry on. Throwing here would
      // discard a report covering the schedules already flipped AND woken above — a partial change
      // announced as a total failure, which is the one ending a retry cannot put right.
      if (!isReadOnlyError(e)) throw e;
      skipped.push({ id: doc.id, kind: 'denied',
        reason: `owned by "${e.owner || 'global'}" and shared in read-only — only its owner can change it` });
      continue;
    }
    wakeSchedule(doc.id);
    ids.push(doc.id);
  }
  return { ids, skipped };
}

const everyActionTool: Tool<ToolResultOf<'every_action'>> = {
  name: 'every_action',
  description: `Manage the background jobs the background tool scheduled for later — both recurring ones
(created with an interval) and one-shots (created with an at). A one-shot's row reads interval "once",
with its fire time in nextRun, and it disappears from the list once it has run.

ACTIONS
  list    — Show every schedule with its id, interval, next run time, and active state.
  suspend — Pause a schedule (preserved, stops running until resumed).
  resume  — Resume a suspended schedule (runs nearly immediately, then on its interval).
  cancel  — Permanently delete a schedule. Prefer suspend for a temporary pause.

The id is a schedule id from 'list' or from the background tool. For suspend and resume, pass
id "*" to act on ALL schedules at once. cancel requires a specific id — "*" is not accepted
(no bulk delete).

With id "*", \`ids\` is what actually changed and anything left alone is listed under \`skipped\`, so
\`count\` plus \`skipped\` accounts for everything eligible; no \`skipped\` means all of them changed.
Each entry carries a \`kind\` saying what to do about it — do not read this out of the \`reason\` prose:
  denied      — you may read that schedule but not write it (owned by another profile and shared in
                read-only). Asking again will be refused again; only its owner can change it.
  unavailable — the write could not complete this time. Retrying later may well work.`,
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'suspend', 'resume', 'cancel'],
        description: 'list: show all schedules. suspend/resume: pause or re-enable. cancel: permanently delete.',
      },
      id: {
        type:        'string',
        description: 'Schedule id (suspend/resume/cancel). Use "*" with suspend/resume to act on all; cancel needs a specific id.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, _ctx: ToolContext) {
      const act = input as EveryAction;

      switch (act.action) {
        case 'list': {
          const result = await scheduleStore?.query({});
          const schedules = result?.items ?? [];
          yield {
            type:  'result',
            value: schedules.map((s: Schedule) => ({
              id:       s.id,
              interval: s.intervalMs === undefined ? 'once' : formatDuration(s.intervalMs),
              nextRun:  s.nextRun,
              active:   s.active !== false,
              ...(s.name    !== undefined ? { name:    s.name    } : {}),
              ...(s.lastRun !== undefined ? { lastRun: s.lastRun } : {}),
              ...(s.output  !== undefined ? { output:  s.output  } : {}),
            })),
          };
          return;
        }

        case 'suspend':
        case 'resume': {
          const active = act.action === 'resume';
          if (act.id === '*') {
            const { ids, skipped } = await setActiveAll(active);
            const report = { count: ids.length, ids, ...(skipped.length > 0 ? { skipped } : {}) };
            yield {
              type:  'result',
              value: active ? { resumed: true, ...report } : { suspended: true, ...report },
            };
            return;
          }
          if (!(await setActive(act.id, active))) {
            yield { type: 'error', message: `Schedule ${act.id} not found.` };
            return;
          }
          yield {
            type:  'result',
            value: active ? { resumed: true, id: act.id } : { suspended: true, id: act.id },
          };
          return;
        }

        case 'cancel': {
          if (act.id === '*') {
            yield { type: 'error', message: 'cancel requires a specific schedule id; "*" (all) is not permitted for cancel. Suspend all with { action: "suspend", id: "*" } instead.' };
            return;
          }
          const ac = activeLoops.get(act.id);
          if (ac) { ac.abort(); activeLoops.delete(act.id); }
          wakeSchedule(act.id);
          await scheduleStore?.delete(act.id);
          yield { type: 'result', value: { cancelled: true, id: act.id } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown every_action "${(act as { action: string }).action}". Expected one of: list, suspend, resume, cancel.` };
      }
    },
  },
};

// ── Plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [backgroundTool, everyActionTool],

  async setup(services: MatbotMachine) {
    if (!services.configPath) return;
    // A spawned background job must not arm its own scheduler — that would cascade.
    if (services.isSubAgent()) return;
    activeConfigPath = services.configPath;
    activeFiles      = services.files;
    notifyOutput = (id, principal, name) => services.Notifier.notify({
      kind: ItemChangeKind, source: 'job-output', operation: 'saved', namespace: 'files', id,
      detail: { namespace: 'workspace', name },      // lets a frontend place the row without re-listing
      ...(principal !== undefined ? { principal } : {}),
    });
    scheduleStore    = services.createStore<Schedule>('schedules');
    pluginAc         = new AbortController();
    const result     = await scheduleStore.query({});
    for (const doc of result.items) armSchedule(doc);
  },

  async teardown() {
    pluginAc?.abort();
    activeLoops.clear();
    scheduleStore    = undefined;
    activeConfigPath = undefined;
    activeFiles      = undefined;
    pluginAc         = undefined;
  },
};
