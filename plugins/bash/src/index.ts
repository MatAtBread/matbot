import type { Tool, ToolEvent, ToolExecutor, ToolContext, ToolContract, ToolResultOf, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

// Single arm. `cwd` is in the params superset shared with the `docker-bash` variant (same tool name ⇒ one
// merged entry, so both must declare it identically); the docker variant ignores `cwd`.
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    bash: ToolContract<{ exitCode: number; stdout: string; stderr: string }, { script: string; cwd?: string; env?: Record<string, string>; timeout?: number }>;
  }
}

interface BashInput {
  script:   string;
  cwd?:     string;
  env?:     Record<string, string>;
  timeout?: number;
}

// Bridge event-emitter callbacks to an AsyncIterable<ToolEvent>.
function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { cwd?: string; env: Record<string, string>; timeout?: number; signal: AbortSignal },
): AsyncIterable<ToolEvent<ToolResultOf<'bash'>>> {
  type Ev = ToolEvent<ToolResultOf<'bash'>>;
  const queue: Array<Ev | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: Ev | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false });

  const killOnAbort = (): void => { child.kill('SIGTERM'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc = '';
  let stderrAcc = '';

  child.stdout?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stdoutAcc += chunk;
    push({ type: 'stdout', chunk });
  });
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stderrAcc += chunk;
    push({ type: 'stderr', chunk });
  });
  child.on('error', (e: Error) => {
    push({ type: 'error', message: e.message });
    push(null);
  });
  child.on('close', (code: number | null) => {
    if (code !== null && code !== 0) {
      push({ type: 'error', message: `Process exited with code ${code}`, code,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else {
      push({ type: 'result', value: { exitCode: code ?? 0, stdout: stdoutAcc, stderr: stderrAcc } });
    }
    push(null);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout !== undefined) {
    timer = setTimeout(() => child.kill('SIGTERM'), opts.timeout);
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Ev>> {
          while (queue.length === 0) {
            await new Promise<void>(r => { wakeup = r; });
          }
          const item = queue.shift()!;
          if (item === null) {
            if (timer !== undefined) clearTimeout(timer);
            opts.signal.removeEventListener('abort', killOnAbort);
            return { done: true, value: undefined as never };
          }
          return { done: false, value: item };
        },
        async return(): Promise<IteratorResult<Ev>> {
          if (timer !== undefined) clearTimeout(timer);
          opts.signal.removeEventListener('abort', killOnAbort);
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
      const { script, cwd: cwdInput, env, timeout } = input as BashInput;
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
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
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
