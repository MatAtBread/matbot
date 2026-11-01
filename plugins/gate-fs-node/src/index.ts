import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type { WrapperHandle } from '@matatbread/matbot-function-runner-node';
import { wrapFsModule } from './wrap.js';
import { decisionsFor } from './gate.js';

export { wrapFsModule } from './wrap.js';
export { admit, admitSync, decisionsFor, fsRequest, type Decisions } from './gate.js';
export { directoryOf, realResolve, type Access } from './paths.js';

/**
 * gate-fs-node — puts each path a `tool_function` body's `node:fs` names to the permission gate.
 *
 * The import gate asks whether a body may import `node:fs` at all; once it may, the module is granted
 * whole — every path matbot's user can reach, `.env` and `.data` included. This plugin registers an
 * {@link ImportedModuleWrapper} for `node:fs` and `node:fs/promises`, so the module a body receives asks
 * again per path: `tool_function.fs-read` or `tool_function.fs-write`, keyed by the function and the
 * path's realpath, through the same `PermissionGate` and the same store of standing answers as the import
 * itself. There is no list of its own — what a body may touch without being asked is a standing answer,
 * given at a prompt or configured under `default_settings:` for the gate.
 *
 * An asynchronous call asks (a prompt when nothing standing decides); a synchronous one cannot — it
 * blocks the very thread a prompt needs — so it consults the answers in force when the module was
 * imported, plus any given since, and throws when they do not allow it.
 *
 * **What it is.** A guardrail against an OVER-REACHING body. It is NOT a sandbox against hostile code: a
 * granted PACKAGE gets the raw `node:fs` (it is trusted as itself), and code can reach another IO module
 * (`node:child_process`). Bounding what the PROCESS may touch is the deployment's — the OS user matbot runs
 * as, a container, or node's `--permission` model. See docs/SECURITY.md.
 *
 * Needs a `FunctionRunner` that offers `ImportedModuleWrapper` (the node runner does). Without one, the
 * `mounted.observe` never fires and the plugin does nothing.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    // Registered through the mount table so it follows the runner: replay seeds it against the runner
    // present now, and a runner reload (whose new registry starts empty) re-fires this and re-registers.
    // The handles are withdrawn in teardown(), since a wrapper is not a host-tracked surface.
    for (const spec of ['node:fs', 'node:fs/promises'] as const) {
      services.mounted.observe({ key: 'ImportedModuleWrapper', replay: true }, m => {
        handles.push(m.ImportedModuleWrapper!(spec, async (mod, ctx) =>
          wrapFsModule(mod as object, spec === 'node:fs' ? 'fs' : 'promises', await decisionsFor(ctx.caller), ctx.caller)));
      });
    }
  },

  async teardown() {
    for (const h of handles.splice(0)) h.remove();
  },
};

const handles: WrapperHandle[] = [];
