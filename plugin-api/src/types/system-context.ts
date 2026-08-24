import type { Session } from './messages.js';

// ── System context ────────────────────────────────────────────────────────────

export type SystemContextContributor = (ctx: {
  session:   Session;
  signal:    AbortSignal;
}) => string | null | Promise<string | null>;

/** One contributor's contribution to a turn's system prompt, with the plugin that registered it.
 *  `plugin` is absent for a contributor registered outside the plugin-scoped facade (the host's own),
 *  since `register`'s `pluginName` is optional. */
export interface SystemContextPart {
  plugin?: string;
  text:    string;
}

export interface SystemContextRegistry {
  register(contributor: SystemContextContributor, pluginName?: string): void;
  removeByPlugin(pluginName: string): void;
  /** Calls all contributors and joins non-null, non-empty results with double newlines. */
  build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null>;
  /** The same contributions {@link build} joins, kept apart and attributed — what `about_matbot`
   *  reports so "why is this in my prompt?" has an answer naming the plugin that put it there. */
  parts(ctx: { session: Session; signal: AbortSignal }): Promise<SystemContextPart[]>;
}
