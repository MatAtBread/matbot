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
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // `background` discriminates on `interval`'s presence, not an `action` field: a call passing an
    // `interval` is a recurring schedule (narrows to the recurring arm); a run-once call omits it and
    // matches the run-once arm — the recurring arm requires `interval`, so the two don't overlap.
    background:
      | ToolContract<{ id: string; interval: string; name?: string }, { prompt: string; interval: string; name?: string; output?: string; provider?: string }>  // recurring (id is the handle)
      | ToolContract<{ status: 'started'; output?: string }, { prompt: string; output?: string; provider?: string }>;                                            // run-once
    // `every_action` discriminates on `action`; resume/suspend results further split on whether id is "*"
    // (all) vs a single id, which a caller can't predeclare, so each keeps its two-shape result union.
    every_action:
      | ToolContract<Array<{ id: string; interval: string; nextRun: string; active: boolean; name?: string; lastRun?: string; output?: string }>, { action: 'list' }>
      | ToolContract<{ resumed:   true; count: number; ids: string[] } | { resumed:   true; id: string }, { action: 'resume';  id: string }>
      | ToolContract<{ suspended: true; count: number; ids: string[] } | { suspended: true; id: string }, { action: 'suspend'; id: string }>
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

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}". Use e.g. "30s", "5m", "1h", "24h".`);
  return parseFloat(m[1]!) * (DURATION_FACTORS[m[2]!] ?? 1);
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000  === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000     === 0) return `${ms / 60_000}m`;
  if (ms % 1_000      === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

// ── Schedule types & storage ──────────────────────────────────────────────────

interface Schedule {
  id:         string;
  version:    string;
  prompt:     string;
  intervalMs: number;
  createdAt:  string;
  nextRun:    string;
  active?:    boolean;
  name?:      string;
  output?:    string;
  lastRun?:   string;
  provider?:  string;
  // Creator identity, captured at creation and replayed each fire so a recurring job runs as the
  // user who scheduled it. Absent on legacy rows ⇒ the child falls back to its own boot default.
  principal?: Principal;
}

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
    const id = isFinite(ms) ? setTimeout(resolve, ms) : undefined;
    const cleanup = () => { if (id !== undefined) clearTimeout(id); resolve(); };
    signal.addEventListener('abort', cleanup, { once: true });
    wakeSignal?.addEventListener('abort', cleanup, { once: true });
  });
}

function wakeSchedule(id: string): void {
  const wakeAc = sleepControllers.get(id);
  if (wakeAc) { sleepControllers.delete(id); wakeAc.abort(); }
}

function armSchedule(sched: Schedule): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(sched.id)) return;

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(sched.id, ac);

  void (async (): Promise<void> => {
    // Stagger startup: random delay in [10s, intervalMs] to avoid a pulse when
    // the process restarts with multiple schedules all due at the same time.
    // Skip the stagger for suspended schedules — they'll wait indefinitely anyway.
    const { intervalMs } = sched;
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
      let stored = await scheduleStore?.get(sched.id);
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
      sched.lastRun = new Date(now).toISOString();
      sched.nextRun = new Date(now + intervalMs).toISOString();
      sched.version = now.toString();
      await scheduleStore?.set(sched.id, sched);

      const wakeAc = new AbortController();
      sleepControllers.set(sched.id, wakeAc);
      await sleep(intervalMs, ac.signal, wakeAc.signal);
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

interface BackgroundInput { prompt: string; interval?: string | null; name?: string; output?: string; provider?: string; }

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
  description: `Run a prompt in a detached background process. With no interval it runs once and
returns immediately; with an interval it becomes a recurring schedule that persists across
restarts (manage it afterwards with the every_action tool — the returned id is the handle).

The background process has access to the same tools and providers. Optionally name a workspace
file to capture the process's stdout; without an output file, stdout is discarded.

When the user asks for something in the background, do not wait for the output — notify them the
task has started (and the output filename, if any); they will check the result themselves later.

interval is a duration like "30s", "5m", "1h", "24h". Omitting it — or passing "once" or null —
runs the prompt a single time.

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
        description: 'Recurrence gap, e.g. "30s", "5m", "1h", "24h". Omit (or pass "once"/null) to run a single time.',
      },
      name: {
        type:        'string',
        description: 'Recurring only: optional human-readable label shown in every_action (list).',
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
      const { prompt, interval, name, output, provider } = input as BackgroundInput;
      // Default to the provider driving this turn, not the config default — a background task
      // inherits the model that spawned it unless the tool call names one explicitly.
      const effectiveProvider = provider ?? ctx.provider;

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
      let intervalMs: number;
      try { intervalMs = parseDuration(interval!); }
      catch (e) { yield { type: 'error', message: (e as Error).message }; return; }

      const id  = randomUUID();
      const now = new Date();
      const sched: Schedule = {
        id, version: now.getTime().toString(), prompt, intervalMs, active: true,
        createdAt: now.toISOString(),
        nextRun:   new Date(now.getTime() + intervalMs).toISOString(),
        principal: currentPrincipal(),
        ...(name              !== undefined ? { name              } : {}),
        ...(output            !== undefined ? { output            } : {}),
        ...(effectiveProvider !== undefined ? { provider: effectiveProvider } : {}),
      };
      await scheduleStore.set(sched.id, sched);
      armSchedule(sched);
      yield { type: 'result', value: { id, interval: interval!, ...(name !== undefined ? { name } : {}) } };
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

async function setActiveAll(active: boolean): Promise<string[]> {
  const result = await scheduleStore?.query({});
  const ids: string[] = [];
  for (const doc of result?.items ?? []) {
    if ((doc.active !== false) === active) continue; // already in the target state
    await scheduleStore?.set(doc.id, { ...doc, active, version: Date.now().toString() });
    wakeSchedule(doc.id);
    ids.push(doc.id);
  }
  return ids;
}

const everyActionTool: Tool<ToolResultOf<'every_action'>> = {
  name: 'every_action',
  description: `Manage recurring background schedules created by the background tool (when given an interval).

ACTIONS
  list    — Show every schedule with its id, interval, next run time, and active state.
  suspend — Pause a schedule (preserved, stops running until resumed).
  resume  — Resume a suspended schedule (runs nearly immediately, then on its interval).
  cancel  — Permanently delete a schedule. Prefer suspend for a temporary pause.

The id is a schedule id from 'list' or from the background tool. For suspend and resume, pass
id "*" to act on ALL schedules at once. cancel requires a specific id — "*" is not accepted
(no bulk delete).`,
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
              interval: formatDuration(s.intervalMs),
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
            const ids = await setActiveAll(active);
            yield {
              type:  'result',
              value: active ? { resumed: true, count: ids.length, ids } : { suspended: true, count: ids.length, ids },
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
      kind: 'store-change', source: 'job-output', operation: 'saved', namespace: 'files', id,
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
