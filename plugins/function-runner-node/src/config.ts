import { refusalMessage } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, PluginSettings, Tool, ToolContext, ToolContract, ToolExecutor, ToolResultOf } from '@matatbread/matbot-plugin-api';

/**
 * How long a body may compute without awaiting, in milliseconds. `0` removes the TIME bound and nothing
 * else — not the withheld globals, not the import routing — because a setting about how long a body may
 * compute is not an answer to what a body may reach. Absent ⇒ `FUNCTION_SYNC_LIMIT_MS`.
 */
export const TIMEOUT_KEY = 'timeout_ms';
/**
 * Retired before 0.5.0: an import restriction this runner carried, in front of the permission gate. The
 * gate says the same thing — a standing denial refuses a module outright — so it is not read. Still
 * NAMED, because an installation that authored it would otherwise have its restriction silently become
 * "ask at the call", which is a widening nobody chose.
 */
const RETIRED_IMPORTS_KEY = 'permit_imports';

/** What is IN EFFECT, which is what a reader of this tool wants: the stored override if there is one,
 *  else the installation's `default_settings:` floor, else the coded default. Nothing distinguishes the
 *  three, deliberately — the question a caller is asking is what a body gets, not where it was written. */
export interface RunnerConfig {
  timeoutMs:        number;
  /** The coded default, so `timeoutMs` can be read against something. */
  timeoutMsDefault: number;
  /** The identifiers the runner does not bind. Fixed, and reported so a reader need not guess. */
  withheldGlobals:  string[];
  /** A stored or configured value that could not be used, and what was used instead. */
  problems?:        string[];
}

/** Why `value` cannot be a `timeout_ms`, or `undefined` if it can. */
export function timeoutProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? undefined : 'must be a non-negative integer (0 removes the time bound)';
}

/**
 * The setting as it will be USED. Checked here, and not only by `set`, because `default_settings:` and a
 * hand-edited document reach the runner without passing through the tool. A bad time bound falls back to
 * the coded default.
 */
export async function readRunnerConfig(settings: PluginSettings, codeDefaultMs: number):
    Promise<{ timeoutMs: number; problems: string[] }> {
  const problems: string[] = [];
  const rawTimeout = await settings.get<unknown>(TIMEOUT_KEY);
  let timeoutMs = codeDefaultMs;
  if (rawTimeout !== undefined) {
    const why = timeoutProblem(rawTimeout);
    if (why === undefined) timeoutMs = rawTimeout as number;
    else problems.push(`${TIMEOUT_KEY} ${why}, but is ${JSON.stringify(rawTimeout)}; using ${codeDefaultMs}ms.`);
  }
  if (await settings.get<unknown>(RETIRED_IMPORTS_KEY) !== undefined) {
    problems.push(`${RETIRED_IMPORTS_KEY} is no longer read, so it restricts nothing: every import is asked about at the call. `
      + 'Refuse a module outright with a standing denial in the permission gate instead — under default_settings: '
      + "'@matatbread/matbot-default-gate': { 'deny:tool_function.import': ['* node:child_process'] } — and remove this key.");
  }
  return { timeoutMs, problems };
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    function_runner_config:
      | ToolContract<RunnerConfig, { action: 'get' }>
      | ToolContract<RunnerConfig, { action: 'set'; timeoutMs: number | null }>
      | ToolContract<RunnerConfig, { action: 'clear' }>;
  }
}

/** Prose for the gate: a subject is a key and keys make terrible questions. */
function labelFor(now: RunnerConfig): string {
  return `Change how long a \`tool_function\` body may compute without awaiting? Currently ${
    now.timeoutMs === 0 ? 'unbounded' : `${now.timeoutMs}ms`}.`;
}

/**
 * `function_runner_config` — read and change this runner's setting at run time.
 *
 * The settings are the plugin's own, so an installation authors them under `default_settings:` keyed by
 * the package name, exactly as it would any other plugin's; this tool writes the ordinary per-principal
 * OVERRIDE above that floor, which is the write path a running actor has for every other setting in
 * matbot. The usual consequence of an override applies: a stored value beats the configured default, so
 * this can WIDEN a floor an installation authored. That is why the write is gated, and why an
 * installation needing a bound nothing in-process can lift replaces the runner package, which is what the
 * `FunctionRunner` seam is for.
 *
 * Whose settings a change is depends on how the settings store is partitioned, which is the storage's
 * business: by principal (a profiles backend), so a change is that principal's environment alone, or not
 * at all, so it is every principal's. The runner reads them at the start of each invocation, under that
 * invocation's principal, so either way a change applies from the next run or check — made here, by
 * another process, or in a hand-edited document — with nothing rebuilt and no restart.
 */
export function createRunnerConfigTool(
  services: MatbotMachine,
  codeDefaultMs: number,
): Tool<ToolResultOf<'function_runner_config'>> {
  const current = async (): Promise<RunnerConfig> => {
    const { timeoutMs, problems } = await readRunnerConfig(services.settings(), codeDefaultMs);
    return {
      timeoutMs,
      timeoutMsDefault: codeDefaultMs,
      withheldGlobals:  [...(services.FunctionRunner?.withheldGlobals ?? [])],
      ...(problems.length > 0 ? { problems } : {}),
    };
  };

  const executor: ToolExecutor<ToolResultOf<'function_runner_config'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const args = input as { action?: string; timeoutMs?: unknown };
      const settings = services.settings();
      switch (args.action) {
        case 'get':
          yield { type: 'result', value: await current() };
          return;

        case 'set':
        case 'clear': {
          // `null` is "revert to the installation's default", which is what `delete` means on a layered
          // setting.
          let value: number | null = null;
          if (args.action === 'set') {
            if (args.timeoutMs === undefined) {
              yield { type: 'error', message: 'action "set" requires "timeoutMs". Use "clear" to revert it to the installation default.' };
              return;
            }
            const why = args.timeoutMs === null ? undefined : timeoutProblem(args.timeoutMs);
            if (why !== undefined) {
              yield { type: 'error', message: `"timeoutMs" ${why}, or null to revert to the installation default.` };
              return;
            }
            value = args.timeoutMs as number | null;
          }

          const permit = await ctx.gate({
            gate: 'set', subject: TIMEOUT_KEY, label: labelFor(await current()), fallback: false,
            standing: [
              { subject: TIMEOUT_KEY, label: `Always allow changing \`${TIMEOUT_KEY}\`` },
              { subject: '*', label: 'Always allow changing this runner\'s settings' },
            ],
          });
          if (!permit.allowed) {
            yield { type: 'error', message: `${refusalMessage(permit)} \`${TIMEOUT_KEY}\` was not changed.` };
            return;
          }

          if (value === null) await settings.delete(TIMEOUT_KEY);
          else await settings.set(TIMEOUT_KEY, value);
          // A stored override of the retired key is otherwise unremovable through any tool, and keeps its
          // warning alive; one in `default_settings:` is the yaml's to drop.
          if (args.action === 'clear') await settings.delete(RETIRED_IMPORTS_KEY);
          // Nothing to rebuild: the runner reads this at the start of every invocation, so the next run
          // sees it. Reported as read back, which is what that invocation will get.
          yield { type: 'result', value: await current() };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, set, clear.` };
      }
    },
  };

  return {
    name: 'function_runner_config',
    description:
      'Read or change how `tool_function` bodies are run by this installation (the node FunctionRunner). '
      + '`timeoutMs` is how long a body may compute WITHOUT awaiting; 0 removes that bound and nothing else '
      + '(the withheld globals and the import gate are unaffected). `get` reports what is in effect, the '
      + 'coded default, and the globals the runner does not bind. `set` takes `timeoutMs`, null reverting it '
      + 'to the installation default, as `clear` does (which also forgets a stored `permit_imports`, a '
      + 'retired setting). A change applies from the next run, and asking to '
      + 'make one requires permission. What a body may import is not set here: each import is a permission '
      + 'decision at the call (`gate_action` lists the standing answers).',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:    { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        timeoutMs: { type: ['integer', 'null'], description: 'For "set": the synchronous time bound in ms, 0 for none, or null to revert to the installation default.' },
      },
    },
    executor,
  };
}
