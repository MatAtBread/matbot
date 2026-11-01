import type { ImportCaller } from '@matatbread/matbot-plugin-api';

/**
 * `ImportedModuleWrapper` — the seam by which a body's imported modules are mediated.
 *
 * `function-runner-node` gates WHETHER a body may import a module (`tool_function.import`), but a granted
 * module is otherwise granted whole: `node:fs` then reads every path matbot's user can. This service lets a
 * plugin interpose on a GRANTED module before the body sees it — wrap `node:fs` so each path is a question
 * of its own — without `function-runner-node` knowing any policy. The runner is mechanism; the wrapper is
 * policy, and a separate (optional) plugin.
 *
 * The question a wrapper asks goes to the SAME gate as the import did, under the same identity:
 * {@link ModuleWrapContext.caller} is the importing invocation, as the consumer (function-tools) states it.
 * So there is one policy and one store of standing answers, not a second permission model per module.
 *
 * It is a GUARDRAIL, not a boundary (see docs/SECURITY.md): it covers a body's OWN `import(…)` only. A
 * granted PACKAGE is trusted as itself and gets the raw module, so IO it does is unmediated; bounding what
 * the PROCESS may touch is the deployment's — the OS user matbot runs as, a container, or node's
 * `--permission` model.
 */

/** What a wrapper is told besides the module. */
export interface ModuleWrapContext {
  /** The exact specifier the body imported, canonicalised (`os` → `node:os`, `fs/promises` →
   *  `node:fs/promises`). A wrapper registered for one name uses it to see which member it got. */
  readonly specifier: string;
  /**
   * The invocation importing it, and the gate it asks through. The same object for every import one
   * invocation makes, so a wrapper can share what it learns across them (keyed in a `WeakMap`).
   *
   * An ASYNC operation the wrapper interposes on (`fs/promises.readFile`, a callback-taking `fs.readFile`)
   * awaits {@link ImportCaller.gate}, which prompts when nothing standing decides. A SYNCHRONOUS one
   * (`readFileSync`) can do neither — it blocks the very thread a prompt or a settings read would need —
   * so it consults a {@link ImportCaller.snapshot} taken in advance, and refuses what that does not allow.
   * That asymmetry is intrinsic to sync APIs in an in-process runner, not a limit of this seam.
   */
  readonly caller: ImportCaller;
}

/**
 * Transform the module a body is about to receive into a mediated one. It must return a module of the same
 * shape (it interposes — a `Proxy` over the real module — it does not re-type it), which is why the module
 * is typed `unknown`: it CANNOT be the real module type. The one strongly-typed form — a `KnownModules`-
 * style map of specifier → `typeof import('node:…')` — was tried and removed, because
 * `ImportedModuleWrapper` is a `MatbotServices` member and the tool-types builder emits `MatbotServices`
 * into the environment a function BODY is type-checked against, where `ENV-GATE` (rightly) forbids any
 * `import('node:…')`. So the wrapper narrows the module itself; the body's own type-check is unaffected.
 *
 * **May be async**, and is awaited before the body gets the module — which is where a wrapper does its
 * setup, such as taking the snapshot its synchronous traps will consult.
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
 * through raw, so an installation pays only for what it mediates.
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
  apply(specifier: string, module: unknown, caller: ImportCaller): Promise<unknown>;
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
    async apply(specifier, module, caller) {
      const key = canonicalise(specifier);
      const list = wrappers.get(key);
      if (list === undefined || list.length === 0) return module;
      const ctx: ModuleWrapContext = { specifier: key, caller };
      let mod = module;
      for (const wrap of list) mod = await wrap(mod, ctx);   // in order; each may be async (setup)
      return mod;
    },
  };
}
