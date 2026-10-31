import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from './runner.js';
import { createRunnerConfigTool, readRunnerConfig } from './config.js';
import type { FunctionRunner, MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS, type ReadRunnerSettings, type VmRunSettings } from './runner.js';
export { transformBody, ROUTE } from './body-transform.js';
export { createRunnerConfigTool, IMPORTS_KEY, TIMEOUT_KEY, type RunnerConfig } from './config.js';

/**
 * The runner this plugin registers: one object for the process, whose settings are READ per invocation
 * rather than baked in at setup. Whose settings they are depends on how the settings store is partitioned
 * — by principal, or not at all — which is the storage's business and not something to assume here, so
 * setup reads nothing: a boot read would answer for the boot principal for ever after. An invocation has
 * one principal throughout, so the consumer reads once at its start (`FunctionRunner.settings`) and holds
 * that answer for the whole run or check.
 *
 * The same function is what `function_runner_config` reports through, so the tool and the runner cannot
 * disagree about what a value means — and a change, from the tool, another process or a hand-edited
 * document, applies from the next invocation with nothing rebuilt.
 */
function createRunner(services: MatbotMachine): FunctionRunner {
  // Read per invocation, so a bad value would otherwise be reported on every call.
  const warned = new Set<string>();
  const warnOnce = (m: string): void => {
    if (warned.has(m)) return;
    warned.add(m);
    console.warn(`[matbot] function-runner-node: ${m}`);
  };
  // Named when a package a body asks for is not installed: it is where the user would install it. Absent
  // in a host that resolves packages from no directory of its own.
  const projectDir = services.projectDir;
  return createVmFunctionRunner(FUNCTION_SYNC_LIMIT_MS, projectDir !== undefined ? { projectDir } : {}, async () => {
    const { timeoutMs, permit, problems } = await readRunnerConfig(services.settings(), FUNCTION_SYNC_LIMIT_MS);
    for (const p of problems) warnOnce(p);
    if (timeoutMs === 0) {
      warnOnce('timeout_ms is 0 — tool_function bodies run unbounded, and one that loops without awaiting will freeze this process. The withheld globals and the import gate are unaffected.');
    }
    return { timeoutMs, permit };
  });
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
 * readable and writable at run time through `function_runner_config`. They are read at the start of
 * each invocation, so narrowing what a body may import no longer waits for a restart. They were `function_timeout_ms` and
 * `function_imports` in the host's config, which could not work: the default runner has no way to
 * implement either, so the host was parsing a question only a plugin could answer.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    await services.register('FunctionRunner', createRunner(services));
    services.tools.register(createRunnerConfigTool(services, FUNCTION_SYNC_LIMIT_MS));
  },
};
