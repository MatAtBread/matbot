import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { dirname } from 'node:path';
import { FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from './runner.js';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS } from './runner.js';
export { transformBody, ROUTE } from './body-transform.js';

/**
 * How long a body may compute without awaiting, in milliseconds. `0` removes the TIME bound and nothing
 * else — not the withheld globals, not the import routing — because a setting about how long a body may
 * compute is not an answer to what a body may reach. Absent ⇒ {@link FUNCTION_SYNC_LIMIT_MS}.
 */
const TIMEOUT_KEY = 'timeout_ms';
/**
 * An optional RESTRICTION on what a body may import, as exact specifiers or prefixes (`['node:']`).
 * Absent ⇒ no restriction, and every specifier reaches the gate; `[]` is the opposite of absent and
 * switches imports off. See `FunctionRunner.permittedImports`.
 */
const IMPORTS_KEY = 'permit_imports';

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
 * Its settings are read ONCE, at setup. A restriction on what may be imported is installation authoring,
 * so it belongs in `default_settings:` rather than in something a running actor edits; re-reading it per
 * call would make the restriction depend on write history, and the one thing it exists to express is
 * "never".
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const settings = services.settings();
    const limitMs = await settings.get<number>(TIMEOUT_KEY) ?? FUNCTION_SYNC_LIMIT_MS;
    const permit  = await settings.get<readonly string[]>(IMPORTS_KEY);
    // The directory holding matbot.yaml: the base a granted relative import resolves against, and the
    // one every other part of an install already uses. Absent in a host that has no config file, where a
    // path import is then left to ordinary resolution.
    const projectDir = services.configPath !== undefined ? dirname(services.configPath) : undefined;

    if (limitMs === 0) {
      console.warn('[matbot] function-runner-node: timeout_ms is 0 — tool_function bodies run unbounded, and one that loops without awaiting will freeze this process. The withheld globals and the import gate are unaffected.');
    }
    await services.register('FunctionRunner', createVmFunctionRunner(limitMs, {
      ...(permit !== undefined ? { permit } : {}),
      ...(projectDir !== undefined ? { projectDir } : {}),
    }));
  },
};
