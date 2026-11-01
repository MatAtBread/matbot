import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type { WrapperHandle } from '@matatbread/matbot-function-runner-node';
import { realResolve } from './paths.js';
import { wrapFsModule } from './wrap.js';
import type { FsPolicy } from './policy.js';

export { wrapFsModule } from './wrap.js';
export { pathAllowed, checkPath, type FsPolicy } from './policy.js';

/**
 * gate-fs-node — confines a `tool_function` body's `node:fs` access to permitted paths.
 *
 * It registers an {@link ImportedModuleWrapper} for `node:fs` and `node:fs/promises`, so a body still
 * imports them normally (the import gate still asks whether it may import `node:fs` at all), but the module
 * it receives is a Proxy that checks every path argument against a policy before the real call. The policy
 * always refuses the secrets vault and the runtime-state trees (`.env`, `.data`, `.plugins`, `.git`,
 * `node_modules`) and otherwise confines a body to the project directory, or to `permit_fs_paths` when set.
 * That is exactly the class of over-reach that `read_matbot_source` and `Source__grep` were — a granted
 * `node:fs` reading `.env` and `.data`.
 *
 * **What it is.** A guardrail against an OVER-REACHING body, enforced by RULE. It is NOT a sandbox against
 * hostile code: a granted PACKAGE gets the raw `node:fs` (it is trusted as itself), code can reach a raw
 * binding or another IO module (`node:net`, `node:child_process`), and the policy cannot PROMPT — the
 * wrapper runs in the body's own call stack, which has no gate channel, and a synchronous call
 * (`readFileSync`) could not await one in an in-process runner anyway (blocking the main thread deadlocks
 * the very loop the prompt needs; a worker/child-process runner could, via the Atomics.wait pattern
 * `apps/cli/remote-loader.js` uses, but that is a different runner). Bounding what the PROCESS may touch is
 * the deployment's — the OS user matbot runs as, a container, or node's `--permission` model. See
 * docs/SECURITY.md.
 *
 * Needs a `FunctionRunner` that offers `ImportedModuleWrapper` (the node runner does). Without one, the
 * `mounted.observe` never fires and the plugin does nothing.
 */

const PERMIT_KEY = 'permit_fs_paths';

async function readPolicy(services: MatbotMachine): Promise<FsPolicy> {
  const raw = await services.settings().get<unknown>(PERMIT_KEY);
  const allow = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === 'string' && s !== '').map(realResolve)
    : [];
  return { projectDir: services.projectDir, allow };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    if (services.projectDir === undefined) {
      console.warn('[gate-fs-node] no projectDir: without permit_fs_paths there is no boundary to confine to, so only the configured allow-list (if any) applies.');
    }
    // Registered through the mount table so it follows the runner: replay seeds it against the runner
    // present now, and a runner reload (whose new registry starts empty) re-fires this and re-registers.
    // The handles are withdrawn in teardown(), since a wrapper is not a host-tracked surface.
    for (const spec of ['node:fs', 'node:fs/promises'] as const) {
      services.mounted.observe({ key: 'ImportedModuleWrapper', replay: true }, async m => {
        // Policy is read per import (inside the wrap), so a settings change applies to the next import with
        // nothing rebuilt — and under the importing invocation's own principal.
        handles.push(m.ImportedModuleWrapper!(spec, async mod => {
          const policy = await readPolicy(services);
          return wrapFsModule(mod as object, policy, spec === 'node:fs' ? 'fs' : 'promises') as typeof mod;
        }));
      });
    }
  },

  async teardown() {
    for (const h of handles.splice(0)) h.remove();
  },
};

const handles: WrapperHandle[] = [];
