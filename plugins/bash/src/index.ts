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

export interface DockerConfig {
  image:    string;
  /** Docker --network value. Defaults to Docker's own default (bridge). */
  network?: string;
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

function createDockerExecutor(docker: DockerConfig): ToolExecutor<ToolResultOf<'bash'>> {
  return {
    async *execute(input: unknown, ctx: ToolContext) {
      const { script, env, timeout } = input as BashInput;

      const args = ['run', '--rm', '-i'];

      if (docker.network !== undefined) {
        args.push('--network', docker.network);
      }

      // Mount the session workspace so scripts can read/write workspace files.
      const workdir = ctx.workdir ?? process.cwd();
      args.push('-v', `${workdir}:/workspace`, '--workdir', '/workspace');

      // Only pass explicitly provided env vars — do not leak process.env into the container.
      for (const [k, v] of Object.entries(env ?? {})) {
        args.push('-e', `${k}=${v}`);
      }

      args.push(docker.image, 'bash', '-c', script);

      yield* spawnAndStream('docker', args, {
        ...(timeout !== undefined ? { timeout } : {}),
        env: {}, signal: ctx.signal,
      });
    },
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
  'Run a bash script and stream stdout/stderr in real time. ' +
  'Pass any shell command or multi-line script in the `script` field — it is executed as `bash -c <script>`. ' +
  'Output streams line by line as it is produced. A non-zero exit code yields an error event with accumulated stdout/stderr attached. ' +
  'Use for file operations, build steps, running tests, package installs, or any shell automation. ' +
  'The working directory defaults to the session workspace.';

const INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'Bash script or command to run (passed to `bash -c`).' },
    cwd:     { type: 'string', description: 'Working directory. Defaults to the session workspace.' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables to set.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
  },
} as const;

/**
 * Creates a `bash` tool backed by either a local shell or a Docker container.
 * The tool name and input schema are identical in both cases — callers (including
 * the LLM) cannot distinguish the two implementations.
 */
export function createBashTool(docker?: DockerConfig): Tool<ToolResultOf<'bash'>> {
  return {
    name:        'bash',
    description: TOOL_DESCRIPTION,    inputSchema: INPUT_SCHEMA,
    executor:    docker ? createDockerExecutor(docker) : createLocalExecutor(),
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const bashTool: Tool<ToolResultOf<'bash'>> = createBashTool();

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [bashTool],
};
