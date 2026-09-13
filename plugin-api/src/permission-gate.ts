import { CONFIRM_NO, CONFIRM_YES } from './types/messages.js';
import type { FormField } from './types/messages.js';
import type { PermissionGate } from './types/permission.js';

/**
 * The host's boot `PermissionGate`: ask through the channel in scope, and answer `req.fallback` when
 * there is no channel at all. Nothing stored — no memory, no allowlist, no settings key. That is what
 * makes it a defensible thing to *revert* to when a policy plugin is unloaded; a policy that remembers
 * standing answers is `@matatbread/matbot-default-gate`, which ships in the default plugin list.
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
