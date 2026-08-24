import type { MatbotPluginSpec, Tool, ToolEvent, ToolExecutor, ToolContext, ToolContract, ToolResultOf, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // Declared identically to the local `bash` plugin (same tool name ⇒ one merged entry). `cwd` rides in
    // the shared params superset but is ignored by this container variant.
    bash: ToolContract<{ exitCode: number; stdout: string; stderr: string }, { script: string; cwd?: string; env?: Record<string, string>; timeout?: number; maxOutputBytes?: number }>;
    // result of a get/set/restart action on the container configuration
    bash_config:
      | ToolContract<{ message: string; overrides: BashConfigOverrides; restarted: boolean },                  { action: 'set'; dns?: string[]; name?: string; maxOutputBytes?: number }>
      | ToolContract<{ message: string; restarted: boolean },                                                  { action: 'restart' }>
      | ToolContract<{ defaults: ResolvedConfigView; overrides: BashConfigOverrides; effective: ResolvedConfigView }, { action: 'get' }>;
  }
}

type ResolvedConfigView = { dns: string[] | null; name: string; maxOutputBytes: number };
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getServers } from 'node:dns';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import process from 'node:process';

// ── Configuration ─────────────────────────────────────────────────────────────

interface ContainerConfig {
  /** Docker image to create the container from. */
  image:       string;
  /** Container name — used for --name on creation and as the exec target. */
  name:        string;
  /** Docker --network. Omit to use Docker's default bridge (internet access). */
  network?:    string;
  /** DNS server(s) to pass as --dns to docker run (e.g. ['1.1.1.1']). The token 'host' expands to
   * the host's current resolvers at create time. Omit/[] inherits host DNS (Docker default). */
  dns?:        string[];
  /** Host path mounted read-only at mountPoint. Defaults to process.cwd(). */
  projectRoot: string;
  /** Mount point inside the container for projectRoot (read-only). */
  mountPoint:  string;
  /** Subpath of projectRoot (and mountPoint) mounted read-write for runtime data. */
  dataSubdir:  string;
  /** Working directory inside the container for exec'd scripts. */
  execCwd:     string;
  /** Cap on combined stdout+stderr bytes per command; on exceed the process is killed. */
  maxOutputBytes: number;
}

/**
 * The immutable defaults — only the fields in `BashConfigOverrides` are overridable via persisted
 * settings. `dns` defaults to absent: with no `--dns`, Docker copies the host's resolver config, so
 * the container inherits the host's DNS out of the box.
 */
const CONTAINER: ContainerConfig = {
  image:          'ubuntu:24.04',
  name:           'matbot-bash',
  projectRoot:    process.cwd(),
  mountPoint:     '/app',
  dataSubdir:     '.data',
  execCwd:        '/app/.data/bash-cwd',
  maxOutputBytes: 1_000_000,
};

/** Settings key for user-configurable overrides. */
const SETTINGS_KEY = 'configOverrides';

/** Fields that are safe for the user to override at runtime. */
type BashConfigOverrides = Partial<Pick<ContainerConfig, 'dns' | 'name' | 'maxOutputBytes'>>;

// ── Docker helpers ────────────────────────────────────────────────────────────

function dockerExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new Error('Docker CLI not found — is Docker installed and on PATH?'));
        else reject(new Error(stderr.trim() || err.message));
      } else resolve(stdout.trim());
    });
  });
}

/**
 * Kill the whole process group of a running command (best-effort). docker exec does not propagate
 * signals to the in-container process, so the host reads the group-leader PID the wrapper recorded
 * and KILLs the negative pid (the process group) — taking the script and every child it spawned.
 */
async function killGroup(containerName: string, hostPidfile: string): Promise<void> {
  let pid: string;
  try {
    pid = (await readFile(hostPidfile, 'utf8')).trim();
  } catch {
    return; // not written yet, or already cleaned up — nothing to kill
  }
  if (!/^\d+$/.test(pid)) return;
  await dockerExec(['exec', containerName, 'bash', '-c', `kill -KILL -${pid}`]).catch(() => {});
}

/** The literal `dns` entry that expands to the host's resolvers at container-create time. */
const HOST_DNS_TOKEN = 'host';

function stripPort(addr: string): string {
  const v6 = /^\[(.+)\]:\d+$/.exec(addr);              // [2001:db8::1]:53
  if (v6) return v6[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(addr); // 8.8.8.8:53
  if (v4) return v4[1]!;
  return addr;                                          // bare IPv4 / IPv6
}

/** Addresses no container could usefully use as a DNS server: invalid, loopback, or link-local. */
function isReachableResolver(addr: string): boolean {
  return isIP(addr) !== 0 && !addr.startsWith('127.') && addr !== '::1' && !addr.startsWith('169.254.');
}

/** This machine's non-internal IPv4 addresses (LAN IP, Docker bridge gateway, …) via os, cross-platform. */
function localMachineIPv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

/**
 * Resolve the "host" token to DNS servers a container can actually reach. Prefer the configured
 * upstreams (`getServers()` = the OS resolver list); if those are only loopback — a local forwarder
 * on 127.x that a container can't reach — fall back to this machine's own IP(s), so the container
 * queries the host over the network (the resolver must be listening off-loopback). Empty ⇒ emit no
 * --dns and let Docker's default handling take over.
 */
function hostResolvers(): string[] {
  const upstream = getServers().map(stripPort).filter(isReachableResolver);
  const servers  = upstream.length > 0 ? upstream : localMachineIPv4s().filter(isReachableResolver);
  return [...new Set(servers)];
}

/**
 * Expand `dns` config into concrete --dns values. The `"host"` token is replaced by the host's
 * reachable resolvers (resolved fresh here, not persisted).
 */
function resolveDnsServers(dns: string[] | undefined): string[] {
  if (dns === undefined) return [];
  return dns.flatMap(entry => entry === HOST_DNS_TOKEN ? hostResolvers() : [entry]);
}

/** Force-remove a container by name — swallow "not found" errors. */
async function removeContainer(name: string): Promise<void> {
  try {
    await dockerExec(['rm', '-f', name]);
  } catch {
    // container didn't exist — nothing to do
  }
}

async function ensureContainerRunning(cfg: ContainerConfig): Promise<void> {
  let running: string;
  try {
    running = await dockerExec(['inspect', '--format', '{{.State.Running}}', cfg.name]);
  } catch {
    // Container doesn't exist — create and start it.
    const dataPath = `${cfg.projectRoot}/${cfg.dataSubdir}`;
    await mkdir(dataPath, { recursive: true });

    const args = ['run', '-d', '--name', cfg.name];
    if (cfg.network !== undefined) args.push('--network', cfg.network);
    for (const server of resolveDnsServers(cfg.dns)) {
      args.push('--dns', server);
    }
    args.push(
      '-v', `${cfg.projectRoot}:${cfg.mountPoint}:ro`,
      '-v', `${dataPath}:${cfg.mountPoint}/${cfg.dataSubdir}`,
      cfg.image,
      'sleep', 'infinity',
    );
    await dockerExec(args);
    return;
  }

  if (running !== 'true') {
    await dockerExec(['start', cfg.name]);
  }
}

// ── Management tool ────────────────────────────────────────────────────────────

/**
 * Return the effective ContainerConfig — immutable defaults merged with any
 * persisted overrides.
 */
function effectiveConfig(overrides: BashConfigOverrides): ContainerConfig {
  return { ...CONTAINER, ...overrides };
}

/** Order-sensitive array equality — DNS nameserver order is significant. */
function sameStrings(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when the two configs differ in a way that requires recreating the container. */
function containerAffectingChange(a: ContainerConfig, b: ContainerConfig): boolean {
  return a.name !== b.name || !sameStrings(a.dns, b.dns);
}

type BashConfigInput = { action: string } & BashConfigOverrides;

async function* bashConfigExecutor(
  input: unknown,
  settings: PluginSettings,
): AsyncIterable<ToolEvent<ToolResultOf<'bash_config'>>> {
  const { action, dns, name, maxOutputBytes } = input as BashConfigInput;

  if (action === 'set') {
    if (maxOutputBytes !== undefined && (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1)) {
      yield { type: 'error', message: '"maxOutputBytes" must be a positive number.' };
      return;
    }

    const overrides: BashConfigOverrides = {};
    if (dns !== undefined) overrides.dns = dns;
    if (name !== undefined) overrides.name = name;
    if (maxOutputBytes !== undefined) overrides.maxOutputBytes = maxOutputBytes;

    if (Object.keys(overrides).length === 0) {
      yield { type: 'error', message: 'At least one of "dns", "name", or "maxOutputBytes" must be provided when action is "set".' };
      return;
    }

    // settings is the source of truth: read the current overrides and merge the new
    // ones in (so setting one field doesn't drop another). We now hold both the old
    // config and the new — the one point where we know the name the container is
    // running under *and* the name it should run under next.
    const existing = await settings.get<BashConfigOverrides>(SETTINGS_KEY) ?? {};
    const merged: BashConfigOverrides = { ...existing, ...overrides };

    const oldCfg = effectiveConfig(existing);
    const newCfg = effectiveConfig(merged);
    const restart = containerAffectingChange(oldCfg, newCfg);

    // Persist first so settings reflect the new truth, then tear the old container
    // down by the name it ran under (only dns/name need a rebuild — maxOutputBytes is
    // host-enforced per call). The next bash call reads these settings and recreates it.
    await settings.set(SETTINGS_KEY, merged);
    if (restart) await removeContainer(oldCfg.name);

    yield {
      type: 'result',
      value: {
        message: restart
          ? `Configuration updated: ${JSON.stringify(merged)}. Container "${oldCfg.name}" removed — next bash command will recreate it with the new settings.`
          : `Configuration updated: ${JSON.stringify(merged)}. No container-affecting change — applied to subsequent commands; existing container left running.`,
        overrides: merged,
        restarted: restart,
      },
    };
    return;
  }

  if (action === 'restart') {
    // Force a recreate regardless of config change — recovers a wedged container and re-resolves a
    // "host" DNS token against the host's current resolvers. Transient, nothing persisted.
    const cfg = effectiveConfig(await settings.get<BashConfigOverrides>(SETTINGS_KEY) ?? {});
    await removeContainer(cfg.name);
    try {
      await ensureContainerRunning(cfg);
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }
    yield { type: 'result', value: { message: `Container "${cfg.name}" recreated.`, restarted: true } };
    return;
  }

  if (action === 'get') {
    const saved = await settings.get<BashConfigOverrides>(SETTINGS_KEY);
    yield {
      type: 'result',
      value: {
        defaults:  { dns: CONTAINER.dns ?? null, name: CONTAINER.name, maxOutputBytes: CONTAINER.maxOutputBytes },
        overrides: saved ?? {},
        effective: {
          dns:            saved?.dns            ?? CONTAINER.dns ?? null,
          name:           saved?.name           ?? CONTAINER.name,
          maxOutputBytes: saved?.maxOutputBytes ?? CONTAINER.maxOutputBytes,
        },
      },
    };
    return;
  }

  yield { type: 'error', message: `Unknown action "${String(action)}" — must be "get", "set", or "restart".` };
}

// ── Streaming helper ──────────────────────────────────────────────────────────

function spawnAndStream(
  command: string,
  args:    string[],
  opts:    {
    env:        Record<string, string>;
    timeout?:   number;
    signal:     AbortSignal;
    maxBytes:   number;
    /** Best-effort kill of the in-container process group (docker exec won't propagate our kill). */
    terminate?: () => void;
  },
): AsyncIterable<ToolEvent<ToolResultOf<'bash'>>> {
  type Ev = ToolEvent<ToolResultOf<'bash'>>;
  const queue: Array<Ev | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: Ev | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const child = spawn(command, args, { env: opts.env, shell: false });

  // docker exec won't forward a signal to the in-container process, so stopping means both killing
  // the process group inside the container (terminate) and detaching the local client (child.kill).
  let stopReason: 'timeout' | 'aborted' | 'overflow' | null = null;
  let stopped = false;
  const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    opts.terminate?.();
    child.kill('SIGKILL');
  };

  const killOnAbort = (): void => { stop('aborted'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc = '';
  let stderrAcc = '';
  let totalBytes = 0;
  let finalized = false;

  const onData = (d: Buffer, kind: 'stdout' | 'stderr'): void => {
    if (finalized) return;
    const remaining = opts.maxBytes - totalBytes;
    const slice = d.length > remaining ? d.subarray(0, Math.max(0, remaining)) : d;
    const chunk = slice.toString();
    if (chunk) {
      if (kind === 'stdout') stdoutAcc += chunk; else stderrAcc += chunk;
      totalBytes += slice.length;
      push({ type: kind, chunk });
    }
    if (d.length > remaining) {
      finalized = true;
      push({ type: 'error', message: `Output exceeded the ${opts.maxBytes}-byte limit; process killed. Raise it for one command by passing a larger \`maxOutputBytes\`, or for every command with bash_config { action: "set", maxOutputBytes }.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
      stop('overflow');
      push(null);
    }
  };

  child.stdout?.on('data', (d: Buffer) => onData(d, 'stdout'));
  child.stderr?.on('data', (d: Buffer) => onData(d, 'stderr'));
  child.on('error', (e: Error) => {
    if (finalized) return;
    finalized = true;
    push({ type: 'error', message: e.message });
    push(null);
  });
  child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
    if (finalized) return;
    finalized = true;
    if (stopReason === 'timeout' || stopReason === 'aborted') {
      const why = stopReason === 'timeout' ? `timed out after ${opts.timeout}ms` : 'aborted';
      push({ type: 'error', message: `Process ${why} and was killed.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else if (code === null) {
      // The docker client was killed by a signal nothing here sent (an operator, the OOM killer). `code`
      // is null for that, which the success arm below used to read as exit code 0 — reporting a kill as a
      // clean run. An in-container process that dies of a signal is a different case and still lands in
      // the arm above it: `docker exec` propagates that as its own numeric exit code (137, …).
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
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeout !== undefined) {
    timer = setTimeout(() => stop('timeout'), opts.timeout);
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
          stop('aborted'); // consumer abandoned us early — don't leave the command running
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
  script:          string;
  env?:            Record<string, string>;
  timeout?:        number;
  maxOutputBytes?: number;
}

function createContainerExecutor(settings: PluginSettings): ToolExecutor<ToolResultOf<'bash'>> {
  return {
    async *execute(input: unknown, ctx: ToolContext) {
      // settings is the source of truth; derive the effective config per call (a
      // cheap read, dwarfed by the docker exec it precedes — not a restart).
      const overrides = await settings.get<BashConfigOverrides>(SETTINGS_KEY) ?? {};
      const cfg = effectiveConfig(overrides);

      try {
        await ensureContainerRunning(cfg);
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }

      // execCwd lives inside the rw .data mount — ensure the host-side path exists.
      const hostExecCwd = cfg.projectRoot + cfg.execCwd.slice(cfg.mountPoint.length);
      // PID files live alongside .data (not in the LLM's cwd) on the same rw mount, so the host
      // can read the recorded group-leader PID directly to kill a runaway command.
      const containerPidDir = `${cfg.mountPoint}/${cfg.dataSubdir}/.matbot-exec`;
      const hostPidDir      = `${cfg.projectRoot}/${cfg.dataSubdir}/.matbot-exec`;
      await mkdir(hostExecCwd, { recursive: true });
      await mkdir(hostPidDir,  { recursive: true });

      const { script, env, timeout, maxOutputBytes } = input as BashInput;
      if (maxOutputBytes !== undefined && (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1)) {
        yield { type: 'error', message: '"maxOutputBytes" must be a positive number.' };
        return;
      }

      const execId            = randomUUID();
      const containerPidfile  = `${containerPidDir}/${execId}.pid`;
      const hostPidfile       = `${hostPidDir}/${execId}.pid`;

      // Pass the script and pidfile path by env to avoid quoting; run under setsid so the script
      // bash leads a fresh process group (pgid == its pid), record that pid, then exec the script.
      // On timeout/abort the host kills the negative pid — the whole group, children included.
      const args = ['exec', '-i', '-w', cfg.execCwd,
        '-e', `MATBOT_SCRIPT=${script}`,
        '-e', `MATBOT_PIDFILE=${containerPidfile}`,
      ];
      for (const [k, v] of Object.entries(env ?? {})) {
        args.push('-e', `${k}=${v}`);
      }
      // setsid -w: -w keeps the setsid parent waiting so docker exec stays attached for streaming;
      // without it setsid detaches and the exec returns immediately, orphaning the script.
      args.push(cfg.name, 'setsid', '-w', 'bash', '-c', 'echo $$ > "$MATBOT_PIDFILE"; exec bash -c "$MATBOT_SCRIPT"');

      // terminate fires the group-kill; capture its promise so cleanup waits for the PID to be read
      // before deleting the pidfile (otherwise rm could win the race and killGroup reads ENOENT).
      let killPromise: Promise<void> | undefined;
      try {
        yield* spawnAndStream('docker', args, {
          ...(timeout !== undefined ? { timeout } : {}),
          env: {},
          signal: ctx.signal,
          maxBytes: maxOutputBytes ?? cfg.maxOutputBytes,
          terminate: () => { killPromise = killGroup(cfg.name, hostPidfile); },
        });
      } finally {
        if (killPromise) await killPromise;
        await rm(hostPidfile, { force: true }).catch(() => {});
      }
    },
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
  'Run a bash script inside the persistent docker container and stream stdout/stderr in real time. ' +
  'Pass any shell command or multi-line script in the `script` field — it is executed as `bash -c <script>`. ' +
  'The container runs ubuntu:24.04 with network access; install standard packages with apt freely. ' +
  'The project root is mounted read-only at /app; /app/.data is read-write. ' +
  'A non-zero exit code yields an error event with accumulated stdout/stderr attached. ' +
  'The script and every process it spawns are killed once combined stdout+stderr reaches `maxOutputBytes` ' +
  '(default 1000000) — a default, not a limit: pass a larger value for one command, or use `bash_config` to ' +
  'change it for every command. Prefer redirecting bulk output to a file, since everything returned stays ' +
  'in the conversation and is re-sent on every later round.';

const BASH_INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'Bash script or command to run (passed to `bash -c`).' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
    maxOutputBytes: { type: 'number', minimum: 1, description: 'Kill the script once combined stdout+stderr reaches this many bytes, overriding the configured default (1000000) for this command only.' },
  },
} as const;

const BASH_CONFIG_DESCRIPTION =
  'View or update the docker-bash container configuration. Configurable fields:\n' +
  '  - `dns`: DNS server IPs (e.g. ["1.1.1.1"]), or the token "host" to use the host\'s current resolvers. ' +
  'Omit, or pass [], to inherit the host\'s DNS (the default).\n' +
  '  - `name`: the container label.\n' +
  '  - `maxOutputBytes`: cap on combined stdout+stderr per bash command (default 1000000); on exceed the command is killed. ' +
  'A single command can override it by passing `maxOutputBytes` to `bash` directly; set it here only to change the default for every command.\n' +
  'A `set` persists the overrides. Changing `dns`/`name` removes the running container so the next bash ' +
  'command recreates it; `maxOutputBytes` applies to subsequent commands with no restart. ' +
  'A `restart` force-recreates the container now (e.g. to re-resolve "host" DNS after the host\'s resolvers change).';

const BASH_CONFIG_INPUT_SCHEMA = {
  type:       'object',
  required:   ['action'],
  properties: {
    action:         { type: 'string', enum: ['get', 'set', 'restart'], description: '"get" returns current config; "set" persists overrides; "restart" force-recreates the container.' },
    dns:            { type: 'array', items: { type: 'string' }, description: 'DNS server IPs, or "host" for the host\'s resolvers (set only). [] = inherit host DNS.' },
    name:           { type: 'string', minLength: 1, description: 'Container name (set only).' },
    maxOutputBytes: { type: 'number', minimum: 1, description: 'Max combined stdout+stderr bytes per command (set only).' },
  },
} as const;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const settings = services.settings();

    // We deliberately do NOT reconcile a stale container at boot. A sleeping container from a
    // previous run is reused (matched by name) so the restarted matbot just continues with it.
    // Reuse is by name only — a container created under different mounts/dns is taken as-is; use
    // bash_config set (dns/name) to force a rebuild.

    // Register the bash execution tool
    const bashTool: Tool<ToolResultOf<'bash'>> = {
      name:        'bash',
      description: TOOL_DESCRIPTION,
      inputSchema: BASH_INPUT_SCHEMA,
      executor:    createContainerExecutor(settings),
    };
    services.tools.register(bashTool);

    // Register the configuration management tool
    const configTool: Tool<ToolResultOf<'bash_config'>> = {
      name:        'bash_config',
      description: BASH_CONFIG_DESCRIPTION,
      inputSchema: BASH_CONFIG_INPUT_SCHEMA,
      executor:    { execute: (input) => bashConfigExecutor(input, settings) },
    };
    services.tools.register(configTool);
  },
};
