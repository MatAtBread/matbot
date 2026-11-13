import type { Hook, ToolInputError } from './hooks.js';
import type { Session } from './messages.js';
import type { ProviderConfig, ProviderEntry } from './provider.js';
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
 *  notification per tool (removeByPlugin announces a `removed` per matched tool, or an `added` where it
 *  reinstates the host's built-in of that name); the registering plugin's name rides in `detail`, advisory
 *  as ever — resolve the name for anything authoritative. */
export interface ToolRegistry {
  /** Registers `tool` and returns — there is nothing to await. The name is free in the overwhelming
   *  case, and that path completes in the calling tick, so `setup()` can fire-and-forget. When a
   *  *different* plugin already owns the name the host may resolve it out of band (it can ask the user),
   *  in which case the tool lands after `setup()` has returned, or not at all if the user keeps the
   *  incumbent. The host owns that outcome — a failure to resolve keeps the existing tool, and neither
   *  case can reject into the caller. Registration order across plugins is not a contract; resolve by
   *  name at call time. */
  register(tool: Tool): void;
  /** Through a plugin's machine, removes only a tool that plugin registered; another's is left in
   *  place (with a warning), since remove-then-register would replace it without the collision being
   *  decided. A host built-in the removed tool displaced is current again, as it is when the plugin
   *  unloads; another plugin's tool it displaced is not, having been replaced rather than suspended. */
  remove(name: string): void;
  resolve(name: string): Tool | null;
  list(): readonly Tool[];
  removeByPlugin(pluginName: string): void;
  /** Judge `parameters` for the tool `name` exactly as its executor will before running it: every
   *  `validate` hook. Errors refuse, `[]` is valid, `undefined` means nothing had an opinion. For a
   *  caller that stores a call to make later (a trigger's `invoke`), so it can be refused while its
   *  author is present. Optional: a registry stood up by hand need not validate. */
  validate?(name: string, parameters: unknown): Promise<ToolInputError[] | undefined>;
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
 *
 * A value is a profile or a {@link ProviderAlias} of one, so a reader of a profile's fields
 * (`module`, `model`) narrows first (`isProviderAlias`); `has` is true for both, since an alias is a
 * name a caller may use anywhere a profile's is. `resolve` is the one way from a name to the profile
 * that runs.
 */
export interface ProviderRegistry extends ReadonlyMap<string, ProviderEntry> {
  /** Throws if the entry would break the one-hop rule: an alias whose target is not a profile, or a
   *  name that aliases point at being turned into an alias itself. */
  register(entry: ProviderEntry): void;
  /** Explicit delete (the `provider` tool's `remove`) — removes the entry outright. Throws if it is a
   *  profile an alias points at: the alias would go on being accepted and then fail at every call. */
  remove(name: string): boolean;
  /** The profile `name` runs on: itself, or its alias's target. `undefined` when the name is not
   *  configured; throws (`invalid`) when it is an alias whose target is not, which `revert` or a
   *  hand-edited store can leave behind. */
  resolve(name: string): ProviderConfig | undefined;
  /**
   * Undo a contribution: restore the boot-baseline profile for `name` if one existed (a plugin-supplied
   * profile that shadowed a configured one), otherwise delete it. A plugin that registers providers
   * (e.g. a storage backend replaying them from its medium) calls this for each in its `teardown()`, so
   * unloading it reverts the provider set to the host's boot condition — the multi-valued analogue of a
   * swap-member reverting to its captured boot default.
   */
  revert(name: string): void;
}
