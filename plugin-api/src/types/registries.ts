import type { Hook } from './hooks.js';
import type { Session } from './messages.js';
import type { ProviderConfig } from './provider.js';
import type { Tool } from './tools.js';

// ── Registries ────────────────────────────────────────────────────────────────

/**
 * What `services.hooks` is: the *registration* half of hook dispatch, and the whole of what a plugin can
 * do with it. `MatbotRuntime.hooks` was typed as the `HookRegistry` class, so the plugin contract also
 * advertised the host's dispatch surface (`runScreen`, `runContribute`, `runToolCall`, `runToolResult`,
 * `runFollowup`) — none of which a plugin may call, and which the scoped per-plugin facade had to be
 * `as unknown as`-cast to satisfy. The cast was the tell. Core still holds the class where it dispatches.
 */
export interface HookRegistrar {
  register(hook: Hook): void;
  removeByPlugin(pluginName: string): void;
}

/** Tool CRUD is observed on the {@link Notifier}, as a `RegistryChange` with `registry: 'tools'` — this
 *  registry had its own broadcaster over the same primitive, which is duplication, not layering. One
 *  notification per tool (removeByPlugin announces a `removed` per matched tool); the registering
 *  plugin's name rides in `detail`, advisory as ever — resolve the name for anything authoritative. */
export interface ToolRegistry {
  /** Registers `tool` and returns — there is nothing to await. The name is free in the overwhelming
   *  case, and that path completes in the calling tick, so `setup()` can fire-and-forget. When a
   *  *different* plugin already owns the name the host may resolve it out of band (it can ask the user),
   *  in which case the tool lands after `setup()` has returned, or not at all if the user keeps the
   *  incumbent. The host owns that outcome — a failure to resolve keeps the existing tool, and neither
   *  case can reject into the caller. Registration order across plugins is not a contract; resolve by
   *  name at call time. */
  register(tool: Tool): void;
  remove(name: string): void;
  resolve(name: string): Tool | null;
  list(): readonly Tool[];
  removeByPlugin(pluginName: string): void;
}

/** What the runner tells a {@link ToolPresenter} about the call it's about to make. */
export interface PresentContext {
  /** The session as of this provider call — the persisted user turn plus any assistant/tool turns
   *  taken so far this turn. A presenter ranks the tool set against this. */
  session:  Session;
  /** The provider profile name this turn runs under, so a presenter can tailor to provider
   *  capabilities (e.g. Anthropic's in-context tool_reference expansion). */
  provider: string;
}

/**
 * Chooses which tools are advertised to the model for a single provider call — a read-only *view* over
 * the turn's tool snapshot, NOT tool management. Presentation is orthogonal to the {@link ToolRegistry},
 * which stays the single source of registration, resolution, and type-contracts (its fragile, load-bearing
 * machinery is never a swap surface). The runner consults the presenter before *every* provider call, so
 * an impl may present a subset (deferring a large library behind a search tool) and grow it mid-turn as the
 * model discovers tools. Executor resolution is unaffected — a tool withheld here stays callable by name
 * through the live registry — so presentation only ever changes what the model is *told about*.
 *
 * Optional {@link MatbotServices} member (offer-loosely): absent ⇒ the runner advertises the whole
 * snapshot, byte-identical to today. `present` may return synchronously or async (a reranker).
 */
export interface ToolPresenter {
  present(tools: readonly Tool[], ctx: PresentContext): readonly Tool[] | Promise<readonly Tool[]>;
}

/**
 * The named provider profiles the runtime resolves by name. A `ReadonlyMap` for the many read-only
 * consumers (`services.providers.get`/`has`/`keys`/…), plus a sanctioned write path so a plugin can
 * *contribute* profiles live — a storage backend replaying provider definitions it captured in its own
 * medium, or the built-in `provider` tool — exactly as a plugin contributes tools via {@link ToolRegistry}.
 * Keyed by `config.name`; `register` upserts.
 */
export interface ProviderRegistry extends ReadonlyMap<string, ProviderConfig> {
  register(config: ProviderConfig): void;
  /** Explicit delete (the `provider` tool's `remove`) — removes the profile outright. */
  remove(name: string): boolean;
  /**
   * Undo a contribution: restore the boot-baseline profile for `name` if one existed (a plugin-supplied
   * profile that shadowed a configured one), otherwise delete it. A plugin that registers providers
   * (e.g. a storage backend replaying them from its medium) calls this for each in its `teardown()`, so
   * unloading it reverts the provider set to the host's boot condition — the multi-valued analogue of a
   * swap-member reverting to its captured boot default.
   */
  revert(name: string): void;
}
