import type { Tool, ToolExecutor, ToolContext, ToolResultOf, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { streamProcess, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from './stream.js';

interface BashInput {
  script:          string;
  cwd?:            string;
  env?:            Record<string, string>;
  timeout?:        number;
  maxOutputBytes?: number;
}

/** POSIX only: `detached` gives the script its own process group, so a kill can reach every stage it
 *  forked. On Windows it means a new console and `process.kill(-pid)` is not a thing, so that platform
 *  keeps the direct-child kill it always had. */
const OWN_PROCESS_GROUP = process.platform !== 'win32';

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

      const child = spawn('bash', ['-c', script], { cwd, env: mergedEnv, shell: false, detached: OWN_PROCESS_GROUP });

      // `bash -c` forks every pipeline stage as its own process, so signalling the child alone leaves the
      // stages running, reparented to init, still holding the script's stdout. Signal the negative pid —
      // the process group — which reaches the script and everything it spawned. The group outlives its
      // leader while any member is alive, so the SIGKILL escalation still lands after `bash` itself has
      // gone.
      const kill = (sig: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          if (OWN_PROCESS_GROUP) process.kill(-pid, sig);
          else child.kill(sig);
        } catch { /* already gone */ }
      };

      yield* streamProcess(child, {
        ...(timeout !== undefined ? { timeout } : {}),
        signal: ctx.signal, kill,
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
  `The script and every process it spawns are killed after \`timeout\` milliseconds (default ${DEFAULT_TIMEOUT_MS}) ` +
  `or once combined stdout+stderr reaches \`maxOutputBytes\` (default ${DEFAULT_MAX_OUTPUT_BYTES}), whichever comes ` +
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
    timeout: { type: 'number', description: `Kill the script, and every process it spawned, after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.` },
    maxOutputBytes: { type: 'number', minimum: 1, description: `Kill the script once combined stdout+stderr reaches this many bytes. Defaults to ${DEFAULT_MAX_OUTPUT_BYTES}.` },
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
