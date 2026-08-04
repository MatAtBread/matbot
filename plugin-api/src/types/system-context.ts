import type { Session } from './messages.js';

// ── System context ────────────────────────────────────────────────────────────

export type SystemContextContributor = (ctx: {
  session:   Session;
  signal:    AbortSignal;
}) => string | null | Promise<string | null>;

export interface SystemContextRegistry {
  register(contributor: SystemContextContributor, pluginName?: string): void;
  removeByPlugin(pluginName: string): void;
  /** Calls all contributors and joins non-null, non-empty results with double newlines. */
  build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null>;
}
