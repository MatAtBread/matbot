/**
 * `ImportedModuleWrapper` — the seam by which a body's imported modules are mediated.
 *
 * `function-runner-node` gates WHETHER a body may import a module (`tool_function.import`), but a
 * granted module is granted whole: `node:fs` then reads every path matbot's user can, `node:net` opens
 * any socket. The gate is per-module, not per-path or per-host. This service lets a plugin interpose on
 * a GRANTED module before the body sees it — wrap `node:fs` so its path arguments are checked, `node:net`
 * so `connect` is bounded — without `function-runner-node` knowing any policy. The runner is mechanism;
 * the wrapper is policy, and a separate (optional) plugin.
 *
 * It is a GUARDRAIL, not a boundary, and deliberately so (see docs/SECURITY.md):
 *   - it covers a body's OWN `import(…)` only. A granted PACKAGE is trusted as itself and gets the raw
 *     module, so IO it does is unwrapped; raw bindings and string-compiled code are the escape gate's.
 *   - it is applied at `FunctionRunner.import`, which is reached AFTER the import gate and has neither
 *     the gate channel nor the calling function's identity — both are the consumer's. So a wrapper
 *     enforces by RULE (reading its own plugin settings, which are correct under the invocation's
 *     ambient principal, and throwing on a disallowed path/host), not by prompting. That mirrors
 *     `permittedImports`: installation-authored restriction, not a per-operation question.
 *   - bounding what the PROCESS may touch is the deployment's: the OS user matbot runs as, a container,
 *     or node's `--permission` model.
 */

/**
 * What a wrapper is told besides the module. Deliberately small: the runner applies wrappers where a
 * granted module is materialised, which is after the import gate and carries neither the gate channel
 * nor the calling function. A wrapper reads any policy from its own plugin settings (correct under the
 * invocation's ambient principal).
 */
export interface ModuleWrapContext {
  /** The exact specifier the body imported, canonicalised (`os` → `node:os`, `fs/promises` →
   *  `node:fs/promises`). A wrapper registered for one name uses it to see which member it got. */
  readonly specifier: string;
}

/**
 * Transform the module a body is about to receive into a mediated one. It must return a module of the
 * same shape (it interposes — a `Proxy` over the real module — it does not re-type it), which is why the
 * module is typed `unknown`: it CANNOT be the real module type. The one strongly-typed form — a
 * `KnownModules`-style map of specifier → `typeof import('node:…')` — was tried and removed, because
 * `ImportedModuleWrapper` is a `MatbotServices` member and the tool-types builder emits `MatbotServices`
 * into the environment a function BODY is type-checked against, where `ENV-GATE` (rightly) forbids any
 * `import('node:…')`. Every such map entry is an import type, so it leaks a node import into the body dts
 * and the whole emitted dts fails to compile. So the wrapper narrows the module itself (the fs guard does
 * `module as typeof import('node:fs')`); the body's own type-check is unaffected — it resolves
 * `import('node:fs')` against `@types/node` through the builder's `paths`, never through this seam.
 *
 * **May be async.** `import` is already async, so a wrapper returning a `Promise` is awaited — which is
 * where it does any async SETUP (reading its own plugin settings for the allowed set, correct under the
 * invocation's ambient principal) before handing back the proxy. The per-operation story is then the
 * wrapper's own: an **async** operation's trap (`fs/promises.readFile`, `net.connect`) can `await` a
 * {@link PermissionGate} and PROMPT per path/host, exactly as `fetch` does under `tool_function.connect`;
 * a **sync** operation's trap (`readFileSync`) cannot await, so it checks the preloaded allowed set and
 * throws — rule, not prompt. That asymmetry is intrinsic to sync APIs, not a limitation of this seam.
 */
export type ModuleWrap = (module: unknown, ctx: ModuleWrapContext) => unknown | Promise<unknown>;

/** What registering a wrapper hands back: `remove()` withdraws exactly this one. */
export interface WrapperHandle {
  remove(): void;
}

/**
 * Register per-module wrappers the runner applies before a body sees a granted module. Owned and applied
 * by `function-runner-node`; the policy is the registrant's. Every wrapper registered for a specifier is
 * applied in registration order (each wraps the previous's result). A specifier with no wrapper is handed
 * through raw, so an installation pays only for what it restricts.
 *
 * Register through `services.mounted.observe({ key: 'ImportedModuleWrapper', replay: true }, m =>
 * m.ImportedModuleWrapper!(…))`, so the registration is re-applied if the runner is reloaded (the new
 * runner's registry starts empty), and withdraw it in the registrant's `teardown()` with the handle's
 * `remove()` — a wrapper is not a host-tracked surface (a tool, a hook), so `unloadPlugin` does not drop
 * it, and a wrapper from an unloaded plugin would otherwise keep mediating every later import. Removal
 * needs no re-import: the runner re-runs the wrappers on EVERY `import(…)` and caches no wrapped module,
 * so the next import simply excludes a removed wrapper, and the only references to it are inside in-flight
 * invocations, which are short-lived.
 */
export interface ImportedModuleWrapper {
  (moduleName: string, wrap: ModuleWrap): WrapperHandle;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** See {@link ImportedModuleWrapper}. Absent ⇒ no runner that wraps imported modules is loaded. */
    ImportedModuleWrapper?: ImportedModuleWrapper;
  }
}

/**
 * The registry behind {@link ImportedModuleWrapper}: the `service` a host registers under that key, and
 * the `apply` the runner calls at `import` time. One per runner, so a reload starts empty and registrants
 * re-add through the mount table. `canonicalise` keys both sides the same way, so a wrapper registered
 * for `node:os` also meets an `os` import.
 */
export function createModuleWrapperRegistry(canonicalise: (spec: string) => string): {
  service: ImportedModuleWrapper;
  apply(specifier: string, module: unknown): Promise<unknown>;
} {
  const wrappers = new Map<string, ModuleWrap[]>();
  return {
    service(moduleName: string, wrap: ModuleWrap): WrapperHandle {
      const key = canonicalise(moduleName);
      const list = wrappers.get(key) ?? [];
      list.push(wrap);
      wrappers.set(key, list);
      return {
        remove() {
          const at = wrappers.get(key);
          if (at === undefined) return;
          const i = at.indexOf(wrap);
          if (i >= 0) at.splice(i, 1);
        },
      };
    },
    async apply(specifier, module) {
      const key = canonicalise(specifier);
      const list = wrappers.get(key);
      if (list === undefined || list.length === 0) return module;
      const ctx: ModuleWrapContext = { specifier: key };
      let mod = module;
      for (const wrap of list) mod = await wrap(mod, ctx);   // in order; each may be async (setup)
      return mod;
    },
  };
}
