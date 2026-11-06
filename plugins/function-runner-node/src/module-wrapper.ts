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
 * m.ImportedModuleWrapper!.wrapModule(…))`, so the registration is made whichever loads first, replacing your own
 * earlier one when the runner remounts (a reloaded runner keeps what was registered — see
 * {@link sharedModuleWrapperRegistry} — so registering again without removing would wrap twice), and
 * withdraw it in the registrant's `teardown()` with the handle's `remove()` — a wrapper is not a host-tracked surface (a tool, a hook), so `unloadPlugin` does not drop
 * it, and a wrapper from an unloaded plugin would otherwise keep mediating every later import. Removal
 * needs no re-import: the runner re-runs the wrappers on EVERY `import(…)` and caches no wrapped module,
 * so the next import simply excludes a removed wrapper, and the only references to it are inside in-flight
 * invocations, which are short-lived.
 */
export interface ImportedModuleWrapper {
  /** Wrap every later import of `moduleName` with `wrap`, until the handle is removed. */
  wrapModule(moduleName: string, wrap: ModuleWrap): WrapperHandle;
  /**
   * Make `owner[key]` read as `standIn` to a function body, and as itself to everyone else. For what a wrapped
   * module hands out that a body could walk to without naming it: a stream prototype's `constructor` is
   * node's own class, which reaches a file unasked. Only the runner knows what code is a body's, which is why
   * this is the runner's to offer. Optional: a runner that cannot tell leaves it out, and a wrapper relying on
   * it says what is then left open.
   */
  hideFromBody?(owner: object, key: PropertyKey, standIn: unknown): void;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** See {@link ImportedModuleWrapper}. Absent ⇒ no runner that wraps imported modules is loaded. */
    ImportedModuleWrapper?: ImportedModuleWrapper;
  }
}

/**
 * The registry behind {@link ImportedModuleWrapper}: the `wrapModule` half of the service a runner registers
 * under that key, and the `apply` the runner calls at `import` time. `canonicalise` keys both sides the same way, so a wrapper
 * registered for `node:os` also meets an `os` import.
 */
export function createModuleWrapperRegistry(canonicalise: (spec: string) => string): {
  service: Pick<ImportedModuleWrapper, 'wrapModule'>;
  apply(specifier: string, module: unknown, caller: ImportCaller): Promise<unknown>;
} {
  const wrappers = new Map<string, ModuleWrap[]>();
  return {
    service: { wrapModule(moduleName: string, wrap: ModuleWrap): WrapperHandle {
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
    } },
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

type WrapperRegistry = ReturnType<typeof createModuleWrapperRegistry>;
// A global symbol, so a reload of this plugin — a fresh module instance — finds the registry the last one made.
const SHARED = Symbol.for('@matatbread/matbot-function-runner-node#ImportedModuleWrapper');

/**
 * The process's one registry, which every runner this plugin creates applies. One per runner, a reloaded
 * runner started with no wrappers, and mediated nothing until each registrant's mount handler re-registered
 * at the next quiescent edge — while the turn that reloaded it went on, importing `node:fs` raw. Kept for
 * the process instead, a reload changes the runner and nothing about what its imports are wrapped with.
 */
export function sharedModuleWrapperRegistry(canonicalise: (spec: string) => string): WrapperRegistry {
  const g = globalThis as { [SHARED]?: WrapperRegistry };
  return g[SHARED] ??= createModuleWrapperRegistry(canonicalise);
}
