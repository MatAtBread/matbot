import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { dirname } from 'node:path';
import { FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from './runner.js';
import { IMPORTS_KEY, TIMEOUT_KEY, createRunnerConfigTool, type RunnerConfig } from './config.js';
import type { MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS } from './runner.js';
export { transformBody, ROUTE } from './body-transform.js';
export { createRunnerConfigTool, IMPORTS_KEY, TIMEOUT_KEY, type RunnerConfig } from './config.js';

/**
 * Build the runner from this plugin's settings and register it, returning what is now in effect.
 *
 * The ONE place the settings become a runner, so `setup` and `function_runner_config` cannot disagree
 * about what a value means — the tool re-runs this rather than constructing a runner of its own, which
 * is also what makes a change take effect without a restart.
 */
async function installRunner(services: MatbotMachine): Promise<RunnerConfig> {
  const settings = services.settings();
  const limitMs  = await settings.get<number>(TIMEOUT_KEY) ?? FUNCTION_SYNC_LIMIT_MS;
  const permit   = await settings.get<readonly string[]>(IMPORTS_KEY);
  // The directory holding matbot.yaml: the base a granted relative import resolves against, and the
  // one every other part of an install already uses. Absent in a host that has no config file, where a
  // path import is then left to ordinary resolution.
  const projectDir = services.configPath !== undefined ? dirname(services.configPath) : undefined;

  if (limitMs === 0) {
    console.warn('[matbot] function-runner-node: timeout_ms is 0 — tool_function bodies run unbounded, and one that loops without awaiting will freeze this process. The withheld globals and the import gate are unaffected.');
  }
  const runner = createVmFunctionRunner(limitMs, {
    ...(permit !== undefined ? { permit } : {}),
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  await services.register('FunctionRunner', runner);
  return {
    timeoutMs:        limitMs,
    timeoutMsDefault: FUNCTION_SYNC_LIMIT_MS,
    permitImports:    permit === undefined ? null : [...permit],
    withheldGlobals:  [...(runner.withheldGlobals ?? [])],
  };
}

/**
 * The node {@link FunctionRunner}: bounds a `tool_function` body's synchronous stretches, withholds the
 * globals that reach a capability without an import, and routes the body's `import(…)` onto the loader
 * the caller hands each call — so the gate is the only door to a module.
 *
 * A PLUGIN and not part of the host, which is the point: nothing in matbot requires any of this. Without
 * it a body is compiled with `new AsyncFunction` and runs unbounded, unshadowed and ungated, and the
 * declarations it is written against say so. Everything here is reachable through the `FunctionRunner`
 * seam alone, so an installation that wants different behaviour — a worker, a subprocess, another
 * language — replaces this package and touches nothing else.
 *
 * Its two settings are its own, authored under `default_settings:` keyed by this package name, and
 * readable and writable at run time through `function_runner_config` — which rebuilds the runner, so
 * narrowing what a body may import no longer waits for a restart. They were `function_timeout_ms` and
 * `function_imports` in the host's config, which could not work: the default runner has no way to
 * implement either, so the host was parsing a question only a plugin could answer.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    await installRunner(services);
    services.tools.register(createRunnerConfigTool(services, () => installRunner(services), FUNCTION_SYNC_LIMIT_MS));
  },
};
