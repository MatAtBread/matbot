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
  /**
   * The standing answers this act may be remembered as, NARROWEST FIRST — what a policy offers beside
   * "just this once", each as the subject it would store and the prose a human reads. A policy consults
   * {@link subject} and then each of these in order, and may store whichever was chosen; absent, the
   * only standing answer is the exact subject, labelled by the policy.
   *
   * The call site supplies the SUBJECTS because only it knows how its own generalise: a module specifier
   * widens by protocol or by directory, a plugin specifier by registry scope, and neither rule is one a
   * policy could derive without knowing the gate. Which is the point — a policy does **set membership**
   * over strings it never parses, so no gate id is hardcoded in it and a gate this build never compiled
   * against generalises the same way.
   *
   * It supplies the LABELS for the same reason it supplies {@link label}: a subject is a key, chosen to
   * be stable and unambiguous, and keys make terrible prose. `#execute node:fs/` is a correct key and an
   * unusable question. A policy rendering `Always allow "<subject>"` can only ever show the key, because
   * saying it in English needs exactly the knowledge the subject was built to avoid requiring.
   *
   * A policy must never store a subject that was not offered here: that is what keeps this from widening
   * the memory semantics of every other gate.
   */
  standing?: readonly { readonly subject: string; readonly label: string }[];
}

/**
 * Which test in the cascade produced an answer — not *who* answered, but which of the layers a policy
 * consults got there first: a human at the prompt, a standing answer out of configuration, or the call
 * site's own `fallback` because nothing else could decide. matbot's own three are named here; the type
 * stays **open**, because a replacement policy has layers of its own (`'user-stored-preference'`, an
 * org directory, a rule table) and a closed union would mean a policy could not report truthfully
 * without a plugin-api change. Treat an unrecognised source exactly as the prose helper does: report it.
 */
export type PermissionSource =
  /** A human was asked and answered. */
  | 'user'
  /** A standing answer in force — an installation's configured floor or a remembered one; the settings
   *  layering that holds them makes the two indistinguishable by construction, so they share a source. */
  | 'configuration'
  /** Nothing decided and nobody was reachable: {@link PermissionRequest.fallback} stands. */
  | 'fallback'
  | (string & {});

/**
 * The answer: whether the act may proceed, and which layer said so.
 *
 * `source` exists for the REPORT rather than the control flow — a refused tool call that says only
 * "Cancelled." reads to a model as a malfunction, so it hunts for a workaround or a bug to fix. A
 * denial that names its origin is a decision it can relay instead (see {@link refusalMessage}).
 *
 * Nothing branches on `source`, and a gate must not be given one to branch on: the outcome is
 * `allowed`, and a call site that treated `'fallback'` differently from a human's "no" would be
 * reintroducing the policy the gate exists to hold.
 */
export interface PermissionDecision {
  allowed: boolean;
  source:  PermissionSource;
}

/** The allow/deny pair, spelled once. */
export const permitted = (source: PermissionSource): PermissionDecision => ({ allowed: true,  source });
export const refused   = (source: PermissionSource): PermissionDecision => ({ allowed: false, source });

/**
 * What a refused call site tells the caller — including the model, which is the reader this exists for.
 * A bare "Cancelled." is indistinguishable from a fault, and a model that reads a decision as a fault
 * goes looking for the fault: it retries under another spelling, probes for a bug, or reaches for a
 * route around the gate. So the prose names the layer that refused and says, for the two sources where
 * it is true, that there is nothing here to work around.
 *
 * `act` names the operation in the caller's own words when it has them ("Install plugin \"@x/foo\"");
 * the sentence stands without it. An unrecognised source is reported as itself rather than guessed at —
 * a policy's own layer name is prose a human chose, and saying it is more use than "refused".
 */
export function refusalMessage(decision: PermissionDecision, act?: string): string {
  const what = act !== undefined ? `${act}: cancelled` : 'Cancelled';
  const stop = 'This is a decision, not a fault — do not retry it or look for a way around it.';
  switch (decision.source) {
    case 'user':          return `${what} — the user declined. ${stop}`;
    case 'configuration': return `${what} — the installation's permission policy does not allow it. ${stop}`;
    case 'fallback':      return `${what} — permission was required and nobody could be asked, so the non-interactive default applied. Nothing is broken; it needs a user present, or a standing answer in the installation's policy.`;
    default:              return `${what} — refused by the permission policy (${decision.source}). ${stop}`;
  }
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
 * delegates to it, so a pair composes in either load order.
 */
export interface PermissionGate {
  decide(req: PermissionRequest, ask: PromptFn | undefined): Promise<PermissionDecision>;
}
