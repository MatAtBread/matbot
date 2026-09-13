import type { PromptFn } from './tools.js';

/**
 * A privileged operation asking to proceed. Boolean by construction: every gate in the system is
 * allow-or-not, because the *value*-returning prompts (a secret, an API key, `ask_user`) never reach
 * a gate at all — they stay on `ctx.prompt`. Authorization and elicitation are different channels,
 * which is what keeps this shape from growing a routing layer.
 */
export interface PermissionRequest {
  /** Qualified gate id — a small, documented vocabulary (`plugin.add`, `tools.overwrite`). A tool
   *  supplies the SUFFIX only (`'add'`); {@link ToolContext.gate} qualifies it with the tool's
   *  registered name, so a plugin cannot address a gate it does not own, and tool-name collision on
   *  `register` closes the impersonation route. The host reserves `tools.*` for core's own gates.
   *  Open at runtime: a plugin this build never compiled against contributes ids, so a policy must
   *  treat an id it does not recognise as "ask", never as "allow". */
  gate:     string;
  /** What the operation acts on: a tool name, a plugin specifier, a provider profile, an MCP server.
   *  The identifier a policy keys its memory or its delegation on — never folded into `gate`, which
   *  would make the vocabulary unbounded and "unknown gate ⇒ ask" unwritable. It is the identifier
   *  the call site *has*, not a canonical identity: at `plugin.add` the plugin is not loaded, so the
   *  subject is the specifier **as typed**, and a remembered allow for `@x/foo` will not match
   *  `https://…/foo.ts` (different trust root, different decision). */
  subject:  string;
  /** Host- or tool-authored prose naming the specific act. The gate renders it; it never rewrites it. */
  label:    string;
  /** What this site does when nothing can be asked and nothing decides — today's non-interactive
   *  behaviour, stated once per site instead of implied at each. */
  fallback: boolean;
}

/**
 * Decides whether a privileged operation may proceed. A swap-member of `MatbotServices`: the host
 * installs a boot default (ask if a channel exists, else `req.fallback`), a plugin may replace it,
 * and `unregister` reverts to the host's — so unloading a policy plugin means "back to asking" with
 * no revert rule of its own.
 *
 * `ask` is the channel in scope for THIS call — the turn's `PromptFn`, or core's registration-path
 * one — passed per call rather than held, because it is per-turn and frontend-owned. `undefined`
 * means **no human is reachable**; a policy that wants to behave differently then simply checks it.
 *
 * A gate that wants "my rules, else the previous behaviour" captures the gate it displaces and
 * delegates to it (the `ToolCallValidator` idiom), so a pair composes in either load order.
 */
export interface PermissionGate {
  decide(req: PermissionRequest, ask: PromptFn | undefined): Promise<boolean>;
}
