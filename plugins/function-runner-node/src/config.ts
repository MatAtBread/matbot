import { importableByName, refusalMessage } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, PluginSettings, Tool, ToolContext, ToolContract, ToolExecutor, ToolResultOf } from '@matatbread/matbot-plugin-api';

/**
 * How long a body may compute without awaiting, in milliseconds. `0` removes the TIME bound and nothing
 * else — not the withheld globals, not the import routing — because a setting about how long a body may
 * compute is not an answer to what a body may reach. Absent ⇒ `FUNCTION_SYNC_LIMIT_MS`.
 */
export const TIMEOUT_KEY = 'timeout_ms';
/**
 * An optional RESTRICTION on what a body may import, as exact specifiers or prefixes (`['node:']`).
 * Absent ⇒ no restriction, and every specifier reaches the gate; `[]` is the opposite of absent and
 * switches imports off. See `FunctionRunner.permittedImports`.
 */
export const IMPORTS_KEY = 'permit_imports';

/** What is IN EFFECT, which is what a reader of this tool wants: the stored override if there is one,
 *  else the installation's `default_settings:` floor, else the coded default. Nothing distinguishes the
 *  three, deliberately — the question a caller is asking is what a body gets, not where it was written. */
export interface RunnerConfig {
  timeoutMs:        number;
  /** The coded default, so `timeoutMs` can be read against something. */
  timeoutMsDefault: number;
  /** `null` ⇒ no restriction: every specifier reaches the gate. `[]` ⇒ imports are switched off. */
  permitImports:    string[] | null;
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

/** Why `value` cannot be a `permit_imports`, or `undefined` if it can. An entry naming a path or a URL
 *  is refused rather than kept, since it could never admit anything a body is allowed to import. */
export function permitProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.every(s => typeof s === 'string' && s !== '')) {
    return 'must be an array of non-empty specifiers or prefixes (e.g. ["node:", "node:fs"]), or [] to switch imports off';
  }
  const bad = value.filter(p => !importableByName(p.replace(/\/$/, '')));
  return bad.length > 0
    ? `names something a body can never import (${bad.join(', ')}): entries are node builtins or package names, never paths or URLs`
    : undefined;
}

/**
 * The two settings as they will be USED. They are checked here, and not only by `set`, because
 * `default_settings:` and a hand-edited document reach the runner without passing through the tool.
 * A bad time bound falls back to the coded default. A bad restriction falls back to `[]`, so imports are
 * off: falling back to "no restriction" would turn a typo in a restriction into the widest setting.
 */
export async function readRunnerConfig(settings: PluginSettings, codeDefaultMs: number):
    Promise<{ timeoutMs: number; permit: readonly string[] | undefined; problems: string[] }> {
  const problems: string[] = [];
  const rawTimeout = await settings.get<unknown>(TIMEOUT_KEY);
  const rawPermit  = await settings.get<unknown>(IMPORTS_KEY);
  let timeoutMs = codeDefaultMs;
  if (rawTimeout !== undefined) {
    const why = timeoutProblem(rawTimeout);
    if (why === undefined) timeoutMs = rawTimeout as number;
    else problems.push(`${TIMEOUT_KEY} ${why}, but is ${JSON.stringify(rawTimeout)}; using ${codeDefaultMs}ms.`);
  }
  let permit: readonly string[] | undefined;
  if (rawPermit !== undefined) {
    const why = permitProblem(rawPermit);
    if (why === undefined) permit = rawPermit as readonly string[];
    else {
      permit = [];
      problems.push(`${IMPORTS_KEY} ${why}, but is ${JSON.stringify(rawPermit)}; imports are switched off until it is corrected.`);
    }
  }
  return { timeoutMs, permit, problems };
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    function_runner_config:
      | ToolContract<RunnerConfig, { action: 'get' }>
      | ToolContract<RunnerConfig, { action: 'set'; timeoutMs?: number | null; permitImports?: string[] | null }>
      | ToolContract<RunnerConfig, { action: 'clear' }>;
  }
}

/** Prose for the gate, per key: a subject is a key and keys make terrible questions. */
function labelFor(key: string, now: RunnerConfig): string {
  return key === IMPORTS_KEY
    ? `Change what a \`tool_function\` body may import on this installation? Currently ${
        now.permitImports === null ? 'any module, each asked about at the call'
          : now.permitImports.length === 0 ? 'nothing — imports are switched off'
          : now.permitImports.join(', ')}. This is the restriction the per-import prompt cannot widen.`
    : `Change how long a \`tool_function\` body may compute without awaiting? Currently ${
        now.timeoutMs === 0 ? 'unbounded' : `${now.timeoutMs}ms`}.`;
}

/**
 * `function_runner_config` — read and change this runner's two settings at run time.
 *
 * The settings are the plugin's own, so an installation authors them under `default_settings:` keyed by
 * the package name, exactly as it would any other plugin's; this tool writes the ordinary per-principal
 * OVERRIDE above that floor, which is the write path a running actor has for every other setting in
 * matbot. What it buys is that `permit_imports` no longer needs a restart to narrow — and the usual
 * consequence of an override applies: a stored value beats the configured default, so this can WIDEN a
 * floor an installation authored. That is why the write is gated, and why an installation needing a
 * restriction nothing in-process can lift does not reach for this plugin at all: it replaces the runner
 * package, which is what the `FunctionRunner` seam is for.
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
    const { timeoutMs, permit, problems } = await readRunnerConfig(services.settings(), codeDefaultMs);
    return {
      timeoutMs,
      timeoutMsDefault: codeDefaultMs,
      permitImports:    permit === undefined ? null : [...permit],
      withheldGlobals:  [...(services.FunctionRunner?.withheldGlobals ?? [])],
      ...(problems.length > 0 ? { problems } : {}),
    };
  };

  const executor: ToolExecutor<ToolResultOf<'function_runner_config'>> = {
    async *execute(input: unknown, ctx: ToolContext) {
      const args = input as { action?: string; timeoutMs?: unknown; permitImports?: unknown };
      const settings = services.settings();
      switch (args.action) {
        case 'get':
          yield { type: 'result', value: await current() };
          return;

        case 'set':
        case 'clear': {
          // `null` is "revert to the installation's default", which is what `delete` means on a layered
          // setting — not "no restriction", which is what an ABSENT default happens to mean.
          const writes = new Map<string, readonly string[] | number | null>();
          if (args.action === 'clear') {
            writes.set(TIMEOUT_KEY, null);
            writes.set(IMPORTS_KEY, null);
          } else {
            if (args.timeoutMs !== undefined) {
              const why = args.timeoutMs === null ? undefined : timeoutProblem(args.timeoutMs);
              if (why !== undefined) {
                yield { type: 'error', message: `"timeoutMs" ${why}, or null to revert to the installation default.` };
                return;
              }
              writes.set(TIMEOUT_KEY, args.timeoutMs as number | null);
            }
            if (args.permitImports !== undefined) {
              const why = args.permitImports === null ? undefined : permitProblem(args.permitImports);
              if (why !== undefined) {
                yield { type: 'error', message: `"permitImports" ${why}, or null to revert to the installation default.` };
                return;
              }
              writes.set(IMPORTS_KEY, args.permitImports as readonly string[] | null);
            }
            if (writes.size === 0) {
              yield { type: 'error', message: 'action "set" requires at least one of "timeoutMs" or "permitImports". Use "clear" to revert both to the installation default.' };
              return;
            }
          }

          // One decision per KEY, because they are two decisions: what a body may reach and how long it
          // may compute are not the same question, and a standing answer for one must not carry the
          // other. Narrowest first — this key, then any setting of this runner.
          const now = await current();
          for (const key of writes.keys()) {
            const permit = await ctx.gate({
              gate: 'set', subject: key, label: labelFor(key, now), fallback: false,
              standing: [
                { subject: key, label: `Always allow changing \`${key}\`` },
                { subject: '*', label: 'Always allow changing this runner\'s settings' },
              ],
            });
            if (!permit.allowed) {
              yield { type: 'error', message: `${refusalMessage(permit)} \`${key}\` was not changed.` };
              return;
            }
          }

          for (const [key, value] of writes) {
            if (value === null) await settings.delete(key);
            else await settings.set(key, value);
          }
          // Nothing to rebuild: the runner reads these at the start of every invocation, so the next run or
          // check sees them. Reported as read back, which is what that invocation will get.
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
      + 'Two settings. `permitImports` is an optional RESTRICTION on what a body may import, as exact '
      + 'specifiers or prefixes of builtins and package names (["node:"] is every builtin, ["node:fs", '
      + '"node:path"] just those two; a path or a URL is never importable, so cannot be an entry): '
      + 'null means no restriction, so every import is asked about at the call; [] switches imports off '
      + 'entirely. A specifier outside the restriction cannot be allowed by anyone at the call, and it '
      + 'fails the type-check rather than being refused later. `timeoutMs` is how long a body may compute '
      + 'WITHOUT awaiting; 0 removes that bound and nothing else (the withheld globals and the import gate '
      + 'are unaffected). `get` reports what is in effect, the coded default, and the globals the runner '
      + 'does not bind. `set` takes either or both; passing null for one reverts it to the installation '
      + 'default, and `clear` reverts both. A change applies from the next run or check, and asking to make '
      + 'one requires permission. Stored function '
      + 'definitions are NOT re-checked when this changes: `tool_function` with action `check` reports '
      + 'which of them passed in a different environment.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:        { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        timeoutMs:     { type: ['integer', 'null'], description: 'For "set": the synchronous time bound in ms, 0 for none, or null to revert to the installation default.' },
        permitImports: { type: ['array', 'null'], items: { type: 'string' }, description: 'For "set": the specifiers or prefixes a body may import, [] for none, or null to revert to the installation default.' },
      },
    },
    executor,
  };
}
