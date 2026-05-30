import { spawn, type ChildProcess } from 'node:child_process';
import { execArgv, argv, execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync }       from 'node:fs';
import { pathToFileURL }    from 'node:url';
import { randomUUID }       from 'node:crypto';
import type { Readable }    from 'node:stream';
import type {
  MatbotPlugin, MatbotServices, Tool, ToolEvent, ToolContext, FileStore, Store,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

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
  name?:      string;
  output?:    string;
  lastRun?:   string;
  provider?:  string;
}

let scheduleStore:   Store<Schedule> | undefined;
let activeConfigPath: string | undefined;
let activeFiles:     FileStore | undefined;
let pluginAc:        AbortController | undefined;
const activeLoops = new Map<string, AbortController>();

// ── Spawn helpers ─────────────────────────────────────────────────────────────

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

function spawnJob(configPath: string, prompt: string, output?: string, files?: FileStore, provider?: string): ChildProcess | undefined {
  const script = argv[1];
  if (script === undefined) return undefined;

  const captureOut = output !== undefined && files !== undefined;
  const child = spawn(
    execPath,
    [...absoluteExecArgv(script), script, '--config', '-'],
    {
      detached: true,
      stdio:    ['pipe', captureOut ? 'pipe' : 'ignore', 'inherit'],
      // MATBOT_BACKGROUND prevents the background plugin in the child from
      // arming its own scheduler loop, which would cascade exponentially.
      env: { ...process.env, MATBOT_BACKGROUND: '1' },
    },
  );

  if (!child.stdin) return undefined;
  child.stdin.write(buildJobConfig(configPath, prompt, provider));
  child.stdin.end();

  if (captureOut && child.stdout !== null && output !== undefined && files !== undefined) {
    void files.put(output, mimeFromName(output), stdoutStream(child.stdout), { namespace: 'workspace' });
  }

  child.unref();
  return child;
}

// ── Scheduler loop ────────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

function armSchedule(sched: Schedule): void {
  if (!activeConfigPath || !pluginAc) return;
  if (activeLoops.has(sched.id)) return;

  const ac = new AbortController();
  pluginAc.signal.addEventListener('abort', () => ac.abort(), { once: true });
  activeLoops.set(sched.id, ac);

  void (async () => {
    // Stagger startup: random delay in [10s, intervalMs] to avoid a pulse when
    // the process restarts with multiple schedules all due at the same time.
    const { intervalMs } = sched;
    const startupDelay = intervalMs <= 10_000
      ? intervalMs
      : 10_000 + Math.floor(Math.random() * (intervalMs - 10_000));
    await sleep(startupDelay, ac.signal);

    while (!ac.signal.aborted) {
      const child = spawnJob(activeConfigPath!, sched.prompt, sched.output, activeFiles, sched.provider);
      if (child !== undefined) {
        const killChild = () => { child.kill(); };
        ac.signal.addEventListener('abort', killChild, { once: true });
        child.once('exit', () => { ac.signal.removeEventListener('abort', killChild); });
      }
      const now = Date.now();
      sched.lastRun = new Date(now).toISOString();
      sched.nextRun = new Date(now + intervalMs).toISOString();
      sched.version = now.toString();
      await scheduleStore?.set(sched.id, sched);
      await sleep(intervalMs, ac.signal);
    }

    activeLoops.delete(sched.id);
  })();
}

// ── Tools ─────────────────────────────────────────────────────────────────────

interface BackgroundInput { prompt: string; output?: string; provider?: string; }
interface EveryInput      { prompt: string; interval: string; name?: string; output?: string; provider?: string; }
interface CancelInput     { id: string; }

const backgroundTool: Tool = {
  name: 'background',
  description:
    'Run a prompt in the background and return immediately. ' +
    'The background process has access to the same tools and providers. ' +
    'Optionally name a workspace file to capture any stdout the process emits ' +
    '— most useful when the prompt instructs the process to print a result rather ' +
    'than writing it via workspace_write.',
  requires:    ['spawn'],
  inputSchema: {
    type:       'object',
    required:   ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The task for the background process to carry out.' },
      output: {
        type:        'string',
        description: 'Optional workspace filename to capture stdout into (e.g. "summary.md"). If omitted, stdout is discarded.',
      },
      provider: {
        type:        'string',
        description: 'Provider key to use (e.g. "claude-sonnet-4-6"). Defaults to the config default_provider or the first provider.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { prompt, output, provider } = input as BackgroundInput;
      if (!ctx.configPath) {
        yield { type: 'error', message: 'background requires configPath in context.' };
        return;
      }
      spawnJob(ctx.configPath, prompt, output, ctx.files, provider);
      yield { type: 'result', value: { status: 'started', ...(output !== undefined ? { output } : {}) } };
    },
  },
};

const everyTool: Tool = {
  name: 'every',
  description:
    'Schedule a prompt to run repeatedly at a fixed interval. ' +
    'Schedules persist across restarts. Returns the schedule ID needed for every_cancel.',
  requires:    ['spawn'],
  inputSchema: {
    type:       'object',
    required:   ['prompt', 'interval'],
    properties: {
      prompt: {
        type:        'string',
        description: 'Task the background process should carry out on each tick.',
      },
      interval: {
        type:        'string',
        description: 'How often to run, e.g. "30s", "5m", "1h", "24h".',
      },
      name: {
        type:        'string',
        description: 'Optional human-readable label shown in every_list.',
      },
      output: {
        type:        'string',
        description: 'Optional workspace filename to capture stdout into on each run (e.g. "tick.md").',
      },
      provider: {
        type:        'string',
        description: 'Provider key to use on each run (e.g. "claude-sonnet-4-6"). Defaults to the config default_provider or the first provider.',
      },
    },
  },
  executor: {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { prompt, interval, name, output, provider } = input as EveryInput;
      if (!activeConfigPath || !scheduleStore) {
        yield { type: 'error', message: 'every requires the background plugin to be set up with a config path.' };
        return;
      }
      let intervalMs: number;
      try { intervalMs = parseDuration(interval); }
      catch (e) { yield { type: 'error', message: (e as Error).message }; return; }

      const id  = randomUUID();
      const now = new Date();
      const sched: Schedule = {
        id, version: now.getTime().toString(), prompt, intervalMs,
        createdAt: now.toISOString(),
        nextRun:   new Date(now.getTime() + intervalMs).toISOString(),
        ...(name     !== undefined ? { name     } : {}),
        ...(output   !== undefined ? { output   } : {}),
        ...(provider !== undefined ? { provider } : {}),
      };
      await scheduleStore.set(sched.id, sched);
      armSchedule(sched);
      yield { type: 'result', value: { id, interval, ...(name !== undefined ? { name } : {}) } };
    },
  },
};

const everyListTool: Tool = {
  name: 'every_list',
  description: 'List all recurring schedules with their IDs, intervals, and next run times.',
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const result = await scheduleStore?.query({});
      const schedules = result?.items.map(i => i.doc) ?? [];
      yield {
        type:  'result',
        value: schedules.map((s: Schedule) => ({
          id:       s.id,
          interval: formatDuration(s.intervalMs),
          nextRun:  s.nextRun,
          active:   activeLoops.has(s.id),
          ...(s.name    !== undefined ? { name:    s.name    } : {}),
          ...(s.lastRun !== undefined ? { lastRun: s.lastRun } : {}),
          ...(s.output  !== undefined ? { output:  s.output  } : {}),
        })),
      };
    },
  },
};

const everyCancelTool: Tool = {
  name: 'every_cancel',
  description: 'Cancel and remove a recurring schedule by its ID.',
  inputSchema: {
    type:       'object',
    required:   ['id'],
    properties: { id: { type: 'string', description: 'Schedule ID as returned by every.' } },
  },
  executor: {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { id } = input as CancelInput;
      const ac = activeLoops.get(id);
      if (ac) { ac.abort(); activeLoops.delete(id); }
      await scheduleStore?.delete(id);
      yield { type: 'result', value: { cancelled: true, id } };
    },
  },
};

// ── Plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPlugin = {
  name:       'background',
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Run prompts in detached background processes. Schedule recurring prompts with every/every_list/every_cancel.',
  },
  tools: [backgroundTool, everyTool, everyListTool, everyCancelTool],

  async setup(services: MatbotServices) {
    if (!services.configPath) return;
    // A spawned background job must not arm its own scheduler — that would cascade.
    if (process.env['MATBOT_BACKGROUND'] === '1') return;
    activeConfigPath = services.configPath;
    activeFiles      = services.files;
    scheduleStore    = services.createStore<Schedule>('schedules');
    pluginAc         = new AbortController();
    const result     = await scheduleStore.query({});
    for (const { doc } of result.items) armSchedule(doc);
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
