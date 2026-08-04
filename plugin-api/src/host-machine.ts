import type {
  CompletionRequest, MatbotMachine, MatbotServices, Mounted, MountConsumeOptions, SingleTurnRequest,
} from './plugin.js';

/*
 * Host-side machine assembly — the wiring an *embedder* does once at boot, not API a plugin author
 * writes against. It lives behind `@matatbread/matbot-plugin-api/host` so the package root can answer
 * exactly one question: what does a plugin need in order to be a plugin? Publishing these at the root
 * made boot mechanics look like stable author-facing surface, and no plugin in this repo imports one.
 *
 * Split out of plugin.ts as a *file* boundary rather than an export list, so the distinction cannot
 * quietly erode the next time something is added. The plugin-facing halves of the same subsystems stay
 * where they are: `Mounted`/`MountConsumeOptions` (the contract of `services.mounted`) in plugin.ts,
 * `runAs`/`currentPrincipal` in principal-context.ts.
 */

/**
 * Wrap a services object so every registered service is reachable as a member (`services.InterfaceName`),
 * not only via `services.get('InterfaceName')` — one access surface for base members and plugin-registered
 * services alike. A member read of a key the object doesn't carry falls back to its own `get()` (the
 * registry), so the augmentation that declares `InterfaceName?: InterfaceName` is also the access path;
 * the optional `?` is the single call-site signal of "may be absent, null-check it". Assignment throws,
 * directing callers to `register()` (the swap-aware write path). Applied to both the host services object
 * and the per-plugin scoped object, so plugins see the same surface the host does.
 */
export function unifyServices(services: MatbotMachine): MatbotMachine {
  return new Proxy(services, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return typeof key === 'string' ? target.get(key as keyof MatbotServices) : undefined;
    },
    has(target, key) {
      if (Reflect.has(target, key)) return true;
      return typeof key === 'string' && target.get(key as keyof MatbotServices) !== undefined;
    },
    set(_target, key) {
      throw new Error(
        `Cannot assign services.${String(key)} directly — use services.register('${String(key)}', impl) to register or replace a service.`,
      );
    },
  });
}
// ── Capture-safe swap proxies ───────────────────────────────────────────────────

export type SwapFn<T extends object> = (next: T) => void;

/**
 * A capture-safe forwarding proxy: every trap routes to whatever `getCurrent()` returns *now*, so a
 * reference captured before a register()-driven swap keeps resolving to the live impl. getPrototypeOf
 * is forwarded so `instanceof` sees the real impl (the StorageBackend identity checks depend on it);
 * ownKeys + getOwnPropertyDescriptor keep object spread faithful. Methods bind to the current impl,
 * not the proxy. A nullish current (an optional service with nothing registered yet) reads as empty.
 */
export function forwardingProxy<T extends object>(getCurrent: () => T | undefined): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const cur = getCurrent();
      if (cur === undefined) return undefined;
      const val = Reflect.get(cur, prop, cur);
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(cur) : val;
    },
    has(_t, prop)    { const cur = getCurrent(); return cur !== undefined && Reflect.has(cur, prop); },
    getPrototypeOf() { const cur = getCurrent(); return cur === undefined ? null : Reflect.getPrototypeOf(cur); },
    ownKeys()        { const cur = getCurrent(); return cur === undefined ? [] : Reflect.ownKeys(cur); },
    getOwnPropertyDescriptor(_t, prop) {
      const cur = getCurrent();
      if (cur === undefined) return undefined;
      const d = Reflect.getOwnPropertyDescriptor(cur, prop);
      if (d !== undefined) d.configurable = true; // Proxy invariant: props absent from the {} target must be configurable.
      return d;
    },
  });
}

/**
 * Returns [proxy, swap]: the Store/FileStore handle plugins capture, plus the fn register() calls to
 * repoint it at a new backend's store. Built on forwardingProxy so capture-safety is uniform.
 */
export function makeSwappable<T extends object>(initial: T): [T, SwapFn<T>] {
  let current = initial;
  return [forwardingProxy<T>(() => current), (next: T) => { current = next; }];
}

// ── Mount table (host half) ──────────────────────────────────

/** The host-side mount table: {@link Mounted} for plugins, plus the producer half the host drives from
 *  its register/unregister and quiescent-edge flush. */
export interface MountTable {
  readonly mounted: Mounted;
  /** Record that a key's presence may have changed since the last edge (called by register/unregister). */
  markDirty(key: keyof MatbotServices): void;
  /** At a quiescent edge, compute each dirty key's net presence transition and multicast it. */
  flush(): void;
}

interface MountInterest {
  readonly handler:   (machine: MatbotMachine) => void | Promise<void>;
  readonly onUnmount: ((machine: MatbotMachine) => void | Promise<void>) | undefined;
  readonly signal:    AbortSignal | undefined;
}

function reportMountHandlerError(e: unknown): void {
  console.error('[matbot] mounted handler threw:', e instanceof Error ? e.message : e);
}

/**
 * Build a {@link MountTable} over a lazily-read machine. Notifications batch to the quiescent edge
 * ({@link flush}), where each dirty key's net presence (absent→present = mount, present→present =
 * remount, present→absent = committed unload) is multicast to that key's subscribers. The clock holds
 * the last-committed presence per key, so a reload collapses to one remount and a committed unload is
 * well-defined. Presence is read by member access on the unified machine, which resolves both the core
 * getters (StorageBackend/Vault/KnowledgeIndex) and the registry-backed augmented keys.
 */
export function createMountTable(getMachine: () => MatbotMachine): MountTable {
  const interests = new Map<string, Set<MountInterest>>();
  const committed = new Map<string, boolean>();   // last-committed presence per key (the clock)
  const dirty     = new Set<string>();

  const present = (key: string): boolean => (getMachine() as unknown as Record<string, unknown>)[key] !== undefined;

  const run = (fn: (machine: MatbotMachine) => void | Promise<void>, machine: MatbotMachine): void => {
    try {
      const r = fn(machine);
      if (r instanceof Promise) r.catch(reportMountHandlerError);
    } catch (e) { reportMountHandlerError(e); }
  };

  const mounted: Mounted = {
    observe(options, handler) {
      const { key, replay, signal, onUnmount } = options;
      if (signal?.aborted === true) return;
      const interest: MountInterest = {
        handler:   handler as MountInterest['handler'],
        onUnmount: onUnmount as MountInterest['onUnmount'],
        signal,
      };
      let set = interests.get(key);
      if (set === undefined) { set = new Set(); interests.set(key, set); }
      const subs = set;
      subs.add(interest);
      signal?.addEventListener('abort', () => { subs.delete(interest); }, { once: true });
      // Replay on the next microtask (async-iterator parity — never inline in the consume() frame).
      // Reads the live machine, not `committed`: replay is "current state", separate from the clock.
      if (replay === true) queueMicrotask(() => {
        if (signal?.aborted === true) return;
        if (present(key as string)) run(interest.handler, getMachine());
      });
    },
  };

  return {
    mounted,
    markDirty(key) { dirty.add(key as string); },
    flush() {
      if (dirty.size === 0) return;
      const keys = [...dirty];
      dirty.clear();
      const machine = getMachine();
      for (const key of keys) {
        const before = committed.get(key) ?? false;
        const after  = present(key);
        committed.set(key, after);
        const subs = interests.get(key);
        if (subs === undefined) continue;
        if (after) {
          for (const i of subs) run(i.handler, machine);                                  // mount / remount
        } else if (before) {
          for (const i of subs) if (i.onUnmount !== undefined) run(i.onUnmount, machine);  // committed unload
        }
      }
    },
  };
}

/**
 * Build the one-message CompletionRequest for a {@link MatbotRuntime.singleTurn} call, hiding the
 * otherwise-mandatory and meaningless Message fields (id/traceId/createdAt) an out-of-band one-shot
 * has no use for. Pure; the host invokes its own complete() with the result.
 */
export function singleTurnRequest(req: SingleTurnRequest): CompletionRequest {
  return {
    provider: req.provider,
    messages: [{
      id: '', traceId: '', createdAt: new Date().toISOString(), role: 'user',
      content: [{ type: 'text', text: req.prompt }],
    }],
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  };
}
