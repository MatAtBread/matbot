import type { ToolContract, ToolEvent, ToolResultOf } from '@matatbread/matbot-plugin-api';
import type { ChildProcess } from 'node:child_process';

// The `bash` contract, declared once for both implementations of the tool: this local one and
// `docker-bash`, which imports this module. `cwd` is honoured only by the local variant.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    bash: ToolContract<{ exitCode: number; stdout: string; stderr: string }, { script: string; cwd?: string; env?: Record<string, string>; timeout?: number; maxOutputBytes?: number }>;
  }
}

export type BashEvent = ToolEvent<ToolResultOf<'bash'>>;

/** Applied when the caller names no `timeout`. A script with no bound at all is unrecoverable on an
 *  unattended host — nothing left in the process can end it and there is no operator to restart. A
 *  caller who genuinely needs longer passes a bigger number. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Beyond this the script is killed — a runaway that only stopped accumulating would still spin to the
 *  timeout. A DEFAULT, not a limit: `maxOutputBytes` overrides it per call, because the caller is the only
 *  one who knows whether a verbose build is expected output or a `yes` loop.
 *
 *  Generous, because the two failure directions are not symmetric. Output that overflows is output whose
 *  process was KILLED, so too low kills legitimate work — while runaway protection barely notices the
 *  difference: anything genuinely runaway emits megabytes a second and trips this in well under a second
 *  either way. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** SIGTERM → SIGKILL escalation for a script that ignores TERM. */
const KILL_GRACE_MS = 2_000;

/** After the awaited process has exited, how long stdio may stay idle before the call gives up on it.
 *  Reset by every chunk, so a real drain of the pipe buffer completes; only a pipe held open by a
 *  process we are no longer waiting for hits it. */
const EXIT_DRAIN_MS = 250;

export interface StreamOptions {
  /** Milliseconds before the script is killed. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeout?: number;
  maxBytes: number;
  signal:   AbortSignal;
  /** Deliver a signal to the script AND everything it spawned. Called with SIGTERM, then SIGKILL if the
   *  script is still running after a grace period. How the group is reached is the caller's: a local
   *  process group, or a pid recorded inside a container. */
  kill(sig: 'SIGTERM' | 'SIGKILL'): void;
  /** How to raise the output limit, for the overflow message. */
  overflowHint?: string;
}

/**
 * Stream a spawned script's output as `bash` tool events, ending in a `result` or an `error` that carries
 * whatever output was accumulated. The one implementation both `bash` tools use, so a fix to how a script
 * is bounded, killed or drained lands in both.
 */
export function streamProcess(child: ChildProcess, opts: StreamOptions): AsyncIterable<BashEvent> {
  const queue: Array<BashEvent | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: BashEvent | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;

  let stopReason: 'timeout' | 'aborted' | 'overflow' | null = null;
  const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    opts.kill('SIGTERM');
    // Deliberately never cleared: the call ending is not evidence the group is gone — that is the case
    // the escalation exists for. Unref'd, so it holds nothing open.
    setTimeout(() => opts.kill('SIGKILL'), KILL_GRACE_MS).unref();
  };

  const killOnAbort = (): void => { stop('aborted'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc  = '';
  let stderrAcc  = '';
  let totalBytes = 0;
  let finalized  = false;
  let pinned     = false;
  let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  timer.unref();

  const release = (): void => {
    clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    opts.signal.removeEventListener('abort', killOnAbort);
  };

  const fail = (message: string, extra: { code?: number } = {}): void => {
    push({ type: 'error', message, ...extra,
      ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
      ...(stderrAcc ? { stderr: stderrAcc } : {}),
    });
  };

  const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
    if (finalized) return;
    finalized = true;
    release();

    // Honest about a short read: the process we waited for is gone, something else still holds the
    // pipe, and the fixed result shape has no field for it.
    if (pinned) stderrAcc += `\n[bash] the script exited but a surviving process still held its output pipe; output may be truncated.\n`;

    if (stopReason !== null) {
      const why = stopReason === 'timeout'  ? `timed out after ${timeoutMs}ms`
                : stopReason === 'overflow' ? `exceeded the ${opts.maxBytes}-byte output limit (${opts.overflowHint ?? 'raise it by passing a larger `maxOutputBytes`, or redirect bulk output to a file'})`
                :                             'aborted';
      fail(`Process ${why} and was killed, along with every process it spawned.`);
    } else if (code === null) {
      // Killed by a signal nothing here sent (an operator, the OOM killer). `code` is null, which a
      // success arm would read as exit code 0 — reporting a kill as a clean run.
      fail(`Process was killed by ${sig ?? 'a signal'}.`);
    } else if (code !== 0) {
      fail(`Process exited with code ${code}`, { code });
    } else {
      push({ type: 'result', value: { exitCode: code, stdout: stdoutAcc, stderr: stderrAcc } });
    }
    push(null);
  };

  // The awaited process has exited; only its stdio is outstanding. Give the pipes an idle window to
  // deliver what is already buffered, then stop reading: whatever still holds them is not this call.
  const armDrain = (): void => {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      pinned = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(exit?.code ?? null, exit?.sig ?? null);
    }, EXIT_DRAIN_MS);
    drainTimer.unref();
  };

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
    if (exit !== undefined) armDrain();
  };

  child.stdout?.on('data', (d: Buffer) => onData(d, 'stdout'));
  child.stderr?.on('data', (d: Buffer) => onData(d, 'stderr'));
  child.on('error', (e: Error) => {
    if (finalized) return;
    finalized = true;
    release();
    push({ type: 'error', message: e.message });
    push(null);
  });

  // 'exit' is authoritative for completion; 'close' additionally waits for every stdio stream to reach
  // EOF, which a surviving process holding the script's stdout never lets happen — so waiting on it
  // alone pinned the tool call for as long as the orphan lived. 'close' is still preferred when it
  // arrives, since it means the output is complete.
  child.on('exit', (code: number | null, sig: NodeJS.Signals | null) => {
    exit = { code, sig };
    armDrain();
  });
  child.on('close', (code: number | null, sig: NodeJS.Signals | null) => finish(code, sig));

  let iterated = false;
  return {
    [Symbol.asyncIterator]() {
      // One queue, so one consumer: a second iterator would steal the first one's events.
      if (iterated) throw new Error('streamProcess output can be iterated only once');
      iterated = true;
      return {
        async next(): Promise<IteratorResult<BashEvent>> {
          while (queue.length === 0) {
            await new Promise<void>(r => { wakeup = r; });
          }
          const item = queue.shift()!;
          return item === null ? { done: true, value: undefined } : { done: false, value: item };
        },
        async return(): Promise<IteratorResult<BashEvent>> {
          release();
          // The consumer walked away while the script was still running — it would otherwise keep
          // running with nothing reading it.
          if (!finalized) stop('aborted');
          return { done: true, value: undefined };
        },
      };
    },
  };
}
