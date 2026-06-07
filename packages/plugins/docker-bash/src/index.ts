import type { MatbotPluginSpec, Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn, execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

// ── Configuration ─────────────────────────────────────────────────────────────

interface ContainerConfig {
  /** Docker image to create the container from. */
  image:       string;
  /** Container name — used for --name on creation and as the exec target. */
  name:        string;
  /** Docker --network. Omit to use Docker's default bridge (internet access). */
  network?:    string;
  /** Host path mounted read-only at mountPoint. Defaults to process.cwd(). */
  projectRoot: string;
  /** Mount point inside the container for projectRoot (read-only). */
  mountPoint:  string;
  /** Subpath of projectRoot (and mountPoint) mounted read-write for runtime data. */
  dataSubdir:  string;
  /** Working directory inside the container for exec'd scripts. */
  execCwd:     string;
}

const CONTAINER: ContainerConfig = {
  image:       'ubuntu:24.04',
  name:        'matbot-bash',
  projectRoot: process.cwd(),
  mountPoint:  '/app',
  dataSubdir:  '.data',
  execCwd:     '/app/.data/bash-cwd',
};

// ── Docker lifecycle ──────────────────────────────────────────────────────────

function dockerRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function ensureContainerRunning(cfg: ContainerConfig): Promise<void> {
  let running: string;
  try {
    running = await dockerRun(['inspect', '--format', '{{.State.Running}}', cfg.name]);
  } catch {
    // Container doesn't exist — create and start it.
    const dataPath = `${cfg.projectRoot}/${cfg.dataSubdir}`;
    await mkdir(dataPath, { recursive: true });

    const args = ['run', '-d', '--name', cfg.name];
    if (cfg.network !== undefined) args.push('--network', cfg.network);
    args.push(
      '-v', `${cfg.projectRoot}:${cfg.mountPoint}:ro`,
      '-v', `${dataPath}:${cfg.mountPoint}/${cfg.dataSubdir}`,
      cfg.image,
      'sleep', 'infinity',
    );
    await dockerRun(args);
    return;
  }

  if (running !== 'true') {
    await dockerRun(['start', cfg.name]);
  }
}

// ── Streaming helper ──────────────────────────────────────────────────────────

function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { env: Record<string, string>; timeout?: number; signal: AbortSignal },
): AsyncIterable<ToolEvent> {
  const queue: Array<ToolEvent | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: ToolEvent | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const child = spawn(command, args, { env: opts.env, shell: false });

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
        async next(): Promise<IteratorResult<ToolEvent>> {
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
        async return(): Promise<IteratorResult<ToolEvent>> {
          if (timer !== undefined) clearTimeout(timer);
          opts.signal.removeEventListener('abort', killOnAbort);
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

// ── Executor ──────────────────────────────────────────────────────────────────

interface BashInput {
  script:   string;
  env?:     Record<string, string>;
  timeout?: number;
}

function createContainerExecutor(cfg: ContainerConfig) {
  return {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      await ensureContainerRunning(cfg);

      // execCwd lives inside the rw .data mount — ensure the host-side path exists.
      const hostExecCwd = cfg.projectRoot + cfg.execCwd.slice(cfg.mountPoint.length);
      await mkdir(hostExecCwd, { recursive: true });

      const { script, env, timeout } = input as BashInput;

      const args = ['exec', '-i', '-w', cfg.execCwd];
      for (const [k, v] of Object.entries(env ?? {})) {
        args.push('-e', `${k}=${v}`);
      }
      args.push(cfg.name, 'bash', '-c', script);

      yield* spawnAndStream('docker', args, {
        ...(timeout !== undefined ? { timeout } : {}),
        env: {},
        signal: ctx.signal,
      });
    },
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
  'Run a bash script inside the persistent matbot-bash container and stream stdout/stderr in real time. ' +
  'Pass any shell command or multi-line script in the `script` field — it is executed as `bash -c <script>`. ' +
  'The container runs ubuntu:24.04 with network access; install standard packages with apt freely. ' +
  'The project root is mounted read-only at /app; /app/.data is read-write. ' +
  'A non-zero exit code yields an error event with accumulated stdout/stderr attached.';

const INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'Bash script or command to run (passed to `bash -c`).' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
  },
} as const;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const tool: Tool = {
      name:        'bash',
      description: TOOL_DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      executor:    createContainerExecutor(CONTAINER),
    };
    services.tools.register(tool);
  },
};
