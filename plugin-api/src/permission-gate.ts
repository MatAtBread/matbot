import { CONFIRM_NO, CONFIRM_YES } from './types/messages.js';
import type { FormField } from './types/messages.js';
import type { PermissionGate } from './types/permission.js';

/**
 * The bare asking `PermissionGate`: ask through the channel in scope, and answer `req.fallback` when
 * there is no channel at all. Nothing stored — no memory, no allowlist, no settings key.
 *
 * The floor under a hand-assembled machine (a test, a minimal embedder) and the fallback `bindGate`
 * uses when a machine carries no policy at all. matbot's own hosts boot something slightly richer:
 * `@matatbread/matbot-default-gate`'s policy, which is this behaviour plus remembered standing
 * answers, seeded by the host rather than loaded as a plugin — so a minimal install still has both a
 * policy and the `gate_action` tool. Whatever a host seeds is what `unregister` reverts to.
 *
 * A structured `confirm` field, so rich frontends render real buttons and the affirmative is the
 * canonical `CONFIRM_YES` token rather than a parse of a rendered (and possibly localised) label.
 */
export const askPermissionGate: PermissionGate = {
  async decide(req, ask) {
    if (ask === undefined) return req.fallback;
    const field: FormField = { name: 'confirm', label: req.label, type: 'confirm', default: CONFIRM_NO };
    return (await ask(field)).trim().toLowerCase() === CONFIRM_YES;
  },
};
