import { CONFIRM_NO, CONFIRM_YES } from './types/messages.js';
import type { FormField } from './types/messages.js';
import { permitted, refused, type PermissionGate } from './types/permission.js';

/**
 * The bare asking `PermissionGate`: ask through the channel in scope, and answer `req.fallback` when
 * there is no channel at all. Nothing stored — no memory, no allowlist, no settings key.
 *
 * The floor under a hand-assembled machine (a test, a minimal embedder) and the fallback `bindGate`
 * uses when a machine carries no policy at all. `assembleMachine` boots something slightly richer:
 * core's `defaultGate`, which is this behaviour plus remembered standing answers, seeded rather than
 * loaded as a plugin — so a minimal install still has both a policy and the `gate_action` tool.
 * Whatever is seeded is what `unregister` reverts to.
 *
 * A structured `confirm` field, so rich frontends render real buttons and the affirmative is the
 * canonical `CONFIRM_YES` token rather than a parse of a rendered (and possibly localised) label.
 */
export const askPermissionGate: PermissionGate = {
  async decide(req, ask) {
    // Two layers, so two sources: nobody to ask is `fallback`, and anything a human answered — a no
    // included — is `user`.
    if (ask === undefined) return req.fallback ? permitted('fallback') : refused('fallback');
    const field: FormField = { name: 'confirm', label: req.label, type: 'confirm', default: CONFIRM_NO };
    const yes = (await ask(field)).trim().toLowerCase() === CONFIRM_YES;
    return yes ? permitted('user') : refused('user');
  },
};
