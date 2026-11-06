import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from './runner.js';
import { createRunnerConfigTool, readRunnerConfig } from './config.js';
import { sharedModuleWrapperRegistry } from './module-wrapper.js';
import type { ImportedModuleWrapper } from './module-wrapper.js';
import type { FunctionRunner, ImportCaller, MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS, type ReadRunnerSettings, type VmRunSettings } from './runner.js';
export { transformBody, ROUTE } from './body-transform.js';
export { hideFromBody } from './host-only.js';
export { createRunnerConfigTool, TIMEOUT_KEY, type RunnerConfig } from './config.js';
export {
  createModuleWrapperRegistry, sharedModuleWrapperRegistry,
  type ImportedModuleWrapper, type ModuleWrap, type ModuleWrapContext, type WrapperHandle,
} from './module-wrapper.js';

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
function createRunner(services: MatbotMachine): { runner: FunctionRunner; wrapper: ImportedModuleWrapper } {
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
  // The ImportedModuleWrapper registry and the runner reference each other — the runner wraps through
  // `apply`, the registry keys on the runner's `canonicalImport` — so `apply` is a closure the registry
  // fills once both exist. Empty until then, which is only during construction.
  let apply: (spec: string, module: unknown, caller: ImportCaller) => unknown = (_spec, module) => module;
  const runner = createVmFunctionRunner(
    FUNCTION_SYNC_LIMIT_MS,
    { ...(projectDir !== undefined ? { projectDir } : {}), wrapModule: (spec, module, caller) => apply(spec, module, caller) },
    async () => {
      const { timeoutMs, problems } = await readRunnerConfig(services.settings(), FUNCTION_SYNC_LIMIT_MS);
      for (const p of problems) warnOnce(p);
      if (timeoutMs === 0) {
        warnOnce('timeout_ms is 0 — tool_function bodies run unbounded, and one that loops without awaiting will freeze this process. The withheld globals and the import gate are unaffected.');
      }
      return { timeoutMs };
    },
  );
  const registry = sharedModuleWrapperRegistry(runner.canonicalImport ?? (spec => spec));
  apply = registry.apply;
  return { runner, wrapper: registry.service };
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
 * Its setting is its own, authored under `default_settings:` keyed by this package name, and readable
 * and writable at run time through `function_runner_config`. It is read at the start of each
 * invocation, so a change applies with no restart. What a body may IMPORT is not a setting here: it is
 * the permission gate's (`tool_function.import`), where a standing denial refuses a module outright.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const { runner, wrapper } = createRunner(services);
    await services.register('FunctionRunner', runner);
    await services.register('ImportedModuleWrapper', wrapper);
    services.tools.register(createRunnerConfigTool(services, FUNCTION_SYNC_LIMIT_MS));
  },
};
