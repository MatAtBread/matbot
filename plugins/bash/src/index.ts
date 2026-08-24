import type { Tool, ToolEvent, ToolExecutor, ToolContext, ToolContract, ToolResultOf, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

// Single arm. `cwd` is in the params superset shared with the `docker-bash` variant (same tool name ⇒ one
// merged entry, so both must declare it identically); the docker variant ignores `cwd`.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    bash: ToolContract<{ exitCode: number; stdout: string; stderr: string }, { script: string; cwd?: string; env?: Record<string, string>; timeout?: number; maxOutputBytes?: number }>;
  }
}

interface BashInput {
  script:          string;
  cwd?:            string;
  env?:            Record<string, string>;
  timeout?:        number;
  maxOutputBytes?: number;
}

/** Applied when the caller names no `timeout`. A script with no bound at all is unrecoverable on an
 *  unattended host — nothing left in the process can end it and there is no operator to restart. A
 *  caller who genuinely needs longer passes a bigger number. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** SIGTERM → SIGKILL escalation for a stage that ignores TERM. */
const KILL_GRACE_MS = 2_000;

/** After the awaited process has exited, how long stdio may stay idle before the call gives up on it.
 *  Reset by every chunk, so a real drain of the pipe buffer completes; only a pipe held open by a
 *  process we are no longer waiting for hits it. */
const EXIT_DRAIN_MS = 250;

/** Beyond this the group is killed — a runaway that only stopped accumulating would still spin to the
 *  timeout. A DEFAULT, not a limit: `maxOutputBytes` overrides it per call, because the caller is the only
 *  one who knows whether a verbose build is expected output or a `yes` loop.
 *
 *  Generous, because the two failure directions are not symmetric. Output that overflows is output whose
 *  process was KILLED, so too low kills legitimate work — while runaway protection barely notices the
 *  difference: anything genuinely runaway emits megabytes a second and trips this in well under a second
 *  either way. Matches `docker-bash`'s default; the two same-named tools must behave alike. */
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** POSIX only: `detached` gives the script its own process group, so a kill can reach every stage it
 *  forked. On Windows it means a new console and `process.kill(-pid)` is not a thing, so that platform
 *  keeps the direct-child kill it always had. */
const OWN_PROCESS_GROUP = process.platform !== 'win32';

// Bridge event-emitter callbacks to an AsyncIterable<ToolEvent>.
function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { cwd?: string; env: Record<string, string>; timeout?: number; maxBytes: number; signal: AbortSignal },
): AsyncIterable<ToolEvent<ToolResultOf<'bash'>>> {
  type Ev = ToolEvent<ToolResultOf<'bash'>>;
  const queue: Array<Ev | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: Ev | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, detached: OWN_PROCESS_GROUP });

  // `bash -c` forks every pipeline stage as its own process, so signalling the child alone leaves the
  // stages running, reparented to init, still holding the script's stdout. Signal the negative pid —
  // the process group — which reaches the script and everything it spawned. The group outlives its
  // leader while any member is alive, so the SIGKILL escalation still lands after `bash` itself has
  // gone.
  const signalGroup = (sig: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (OWN_PROCESS_GROUP) process.kill(-pid, sig);
      else child.kill(sig);
    } catch { /* already gone */ }
  };

  let stopReason: 'timeout' | 'aborted' | 'overflow' | null = null;
  let stopped   = false;
  let killTimer:  ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
    if (stopped) return;
    stopped    = true;
    stopReason = reason;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };

  const killOnAbort = (): void => { stop('aborted'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc  = '';
  let stderrAcc  = '';
  let totalBytes = 0;
  let finalized  = false;
  let exited     = false;
  let pinned     = false;
  let timer:      ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
    if (finalized) return;
    finalized = true;
    if (timer      !== undefined) clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);

    // Honest about a short read: the process we waited for is gone, something else still holds the
    // pipe, and the fixed result shape (shared with `docker-bash`) has no field for it.
    if (pinned) stderrAcc += `\n[bash] the script exited but a surviving process still held its output pipe; output may be truncated.\n`;

    if (stopReason !== null) {
      const why = stopReason === 'timeout'  ? `timed out after ${timeoutMs}ms`
                : stopReason === 'overflow' ? `exceeded the ${opts.maxBytes}-byte output limit (raise it by passing a larger \`maxOutputBytes\`, or redirect bulk output to a file)`
                :                             'aborted';
      push({ type: 'error', message: `Process ${why} and was killed, along with every process it spawned.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else if (code === null) {
      // Killed by a signal nothing here sent (an operator, the OOM killer). `code` is null, which the
      // success arm used to read as exit code 0 — reporting a kill as a clean run.
      push({ type: 'error', message: `Process was killed by ${sig ?? 'a signal'}.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else if (code !== 0) {
      push({ type: 'error', message: `Process exited with code ${code}`, code,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else {
      push({ type: 'result', value: { exitCode: code, stdout: stdoutAcc, stderr: stderrAcc } });
    }
    push(null);
  };

  // The awaited process has exited; only its stdio is outstanding. Give the pipes an idle window to
  // deliver what is already buffered, then stop reading: whatever still holds them is not this call.
  const armDrain = (code: number | null, sig: NodeJS.Signals | null): void => {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      pinned = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code, sig);
    }, EXIT_DRAIN_MS);
    drainTimer.unref();
  };

  let exitCode: number | null = null;
  let exitSig:  NodeJS.Signals | null = null;

  const onData = (d: Buffer, kind: 'stdout' | 'stderr'): void => {
    if (finalized) return;
    const remaining = opts.maxBytes - totalBytes;
    const slice     = d.length > remaining ? d.subarray(0, Math.max(0, remaining)) : d;
    const chunk     = slice.toString();
    if (chunk) {
      if (kind === 'stdout') stdoutAcc += chunk; else stderrAcc += chunk;
      totalBytes += slice.length;
      push({ type: kind, chunk });
    }
    if (d.length > remaining) {
      stop('overflow');
      finish(null, null);
      return;
    }
    if (exited) armDrain(exitCode, exitSig);
  };

  child.stdout?.on('data', (d: Buffer) => onData(d, 'stdout'));
  child.stderr?.on('data', (d: Buffer) => onData(d, 'stderr'));
  child.on('error', (e: Error) => {
    if (finalized) return;
    finalized = true;
    if (timer      !== undefined) clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    push({ type: 'error', message: e.message });
    push(null);
  });

  // 'exit' is authoritative for completion; 'close' additionally waits for every stdio stream to reach
  // EOF, which a surviving process holding the script's stdout never lets happen — so waiting on it
  // alone pinned the tool call for as long as the orphan lived. 'close' is still preferred when it
  // arrives, since it means the output is complete.
  child.on('exit', (code: number | null, sig: NodeJS.Signals | null) => {
    exited   = true;
    exitCode = code;
    exitSig  = sig;
    armDrain(code, sig);
  });
  child.on('close', (code: number | null, sig: NodeJS.Signals | null) => finish(code, sig));

  timer = setTimeout(() => stop('timeout'), timeoutMs);
  timer.unref();

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Ev>> {
          while (queue.length === 0) {
            await new Promise<void>(r => { wakeup = r; });
          }
          const item = queue.shift()!;
          if (item === null) {
            if (timer      !== undefined) clearTimeout(timer);
            if (drainTimer !== undefined) clearTimeout(drainTimer);
            // `killTimer` is deliberately NOT cleared: the call ending is not evidence the group is
            // gone — that is the case it exists for. It is unref'd, so an outstanding escalation holds
            // nothing open, and it no-ops (ESRCH) if everything has already exited.
            opts.signal.removeEventListener('abort', killOnAbort);
            return { done: true, value: undefined as never };
          }
          return { done: false, value: item };
        },
        async return(): Promise<IteratorResult<Ev>> {
          if (timer      !== undefined) clearTimeout(timer);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          opts.signal.removeEventListener('abort', killOnAbort);
          // The consumer walked away while the script was still running — the group would otherwise
          // keep running with nothing reading it.
          if (!finalized) stop('aborted');
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

// ── Executors ─────────────────────────────────────────────────────────────────

function createLocalExecutor(): ToolExecutor<ToolResultOf<'bash'>> {
  return {
    async *execute(input: unknown, ctx: ToolContext) {
      const { script, cwd: cwdInput, env, timeout, maxOutputBytes } = input as BashInput;
      if (maxOutputBytes !== undefined && (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1)) {
        yield { type: 'error', message: '"maxOutputBytes" must be a positive number.' };
        return;
      }
      const cwd = cwdInput ?? ctx.workdir;
      if (cwd !== undefined) await mkdir(cwd, { recursive: true });

      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }
      if (env) Object.assign(mergedEnv, env);

      yield* spawnAndStream('bash', ['-c', script], {
        ...(cwd     !== undefined ? { cwd }     : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        env: mergedEnv, signal: ctx.signal,
        maxBytes: maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      });
    },
  };
}

// ── Tool ──────────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
  'Run a bash script and stream stdout/stderr in real time. ' +
  'Pass any shell command or multi-line script in the `script` field — it is executed as `bash -c <script>`. ' +
  'Output streams line by line as it is produced. A non-zero exit code yields an error event with accumulated stdout/stderr attached. ' +
  'Use for build steps, running tests, package installs, or any shell automation. ' +
  'The script and every process it spawns are killed after `timeout` milliseconds (default 600000, ten ' +
  'minutes) or once combined stdout+stderr reaches `maxOutputBytes` (default 1000000), whichever comes ' +
  'first. Both are defaults, not limits: pass a larger value for work that genuinely needs it. Prefer ' +
  'redirecting bulk output to a file over raising `maxOutputBytes`, since everything returned stays in ' +
  'the conversation and is re-sent on every later round. ' +
  'The working directory defaults to a private scratch directory for temporary scripts and intermediate ' +
  'data: it is local to this tool, is not visible to the user, and cannot be served or shared. Files the ' +
  'user asked for do NOT belong here — write those with whichever tool manages stored files.';

const INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'Bash script or command to run (passed to `bash -c`).' },
    cwd:     { type: 'string', description: 'Working directory. Defaults to the private scratch directory.' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables to set.' },
    timeout: { type: 'number', description: 'Kill the script, and every process it spawned, after this many milliseconds. Defaults to 600000 (ten minutes).' },
    maxOutputBytes: { type: 'number', minimum: 1, description: 'Kill the script once combined stdout+stderr reaches this many bytes. Defaults to 1000000.' },
  },
} as const;

// Runs on the host, unsandboxed. For a container-isolated `bash` of the same name and shape, load
// `@matatbread/matbot-tool-docker-bash` instead — it owns the sandboxed implementation.
export const bashTool: Tool<ToolResultOf<'bash'>> = {
  name:        'bash',
  description: TOOL_DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  executor:    createLocalExecutor(),
};

// ── Plugin ────────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [bashTool],
};
