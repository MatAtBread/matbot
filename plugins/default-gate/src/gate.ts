import type { FormField, PermissionGate, PluginSettings } from '@matatbread/matbot-plugin-api';

/** The settings namespace standing answers live in, and what an installation keys `default_settings:`
 *  by. This package's own name, though it is seeded by the host rather than loaded as a plugin — the
 *  name is what makes the yaml key legible, and the hosts exempt it from the "names no loaded plugin"
 *  warning for exactly that reason. Exported because the host builds the settings facade itself. */
export const DEFAULT_GATE_SETTINGS_NS = '@matatbread/matbot-default-gate';

/**
 * A standing answer for one gate id: `true` — allow every subject; a list — allow exactly these
 * subjects; absent (or anything else) — ask. There is no stored "always deny": a refusal is a
 * decision about one act, and a policy that silences a prompt into a permanent no is a policy with
 * rules of its own, which is a different gate rather than a remembered answer.
 */
export type StandingAnswer = true | readonly string[];

/** Boundary check on a value out of config or a store — neither is typed, and a malformed one must not
 *  read as `true` (every subject allowed, no prompt, no trace of why). Anything unrecognised asks. */
export function toStandingAnswer(value: unknown): StandingAnswer | undefined {
  if (value === true) return true;
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  return undefined;
}

/** Whether a standing answer covers this subject. */
const allows = (answer: StandingAnswer | undefined, subject: string): boolean =>
  answer === true || (answer !== undefined && answer.includes(subject));

/**
 * The policy that reproduces matbot's historical behaviour, generalised from tool names to
 * `(gate, subject)`: ask, offer standing answers, remember them. It lives in its own package — out of
 * core and out of the reserved `__matbot_core__` settings namespace — so an installation can
 * *replace* a policy rather than defeat one.
 *
 * Storage is one key per gate id, holding a {@link StandingAnswer}, in this package's own settings
 * namespace — so an install authors the floor the ordinary way and needs no tooling of its own:
 *
 *   default_settings:
 *     '@matatbread/matbot-default-gate':
 *       'tools.overwrite': [bash, plugin]
 *
 * `previous` is whatever gate this one displaced (the host's asking default, in the normal case). It
 * is delegated to when there is nobody to ask — the one case this policy has nothing to add to, and
 * the `ToolCallValidator` idiom that makes two gates compose in either load order.
 */
export function createDefaultGate(settings: PluginSettings, previous?: PermissionGate): PermissionGate {
  const read = async (gate: string): Promise<StandingAnswer | undefined> =>
    toStandingAnswer(await settings.get<unknown>(gate));

  // Write the answer and record the gate id in the index, so `gate_action` can report and clear an
  // answer for a gate id this build never compiled against.
  const remember = async (gate: string, answer: StandingAnswer): Promise<void> => {
    await settings.set(gate, answer);
    const known = await settings.get<unknown>(WRITTEN_GATES_KEY);
    const ids   = Array.isArray(known) ? known.filter((g): g is string => typeof g === 'string') : [];
    if (!ids.includes(gate)) await settings.set(WRITTEN_GATES_KEY, [...ids, gate]);
  };

  return {
    async decide(req, ask) {
      if (allows(await read(req.gate), req.subject)) return true;

      // Nothing stored and nobody to ask: the displaced gate answers, which for the host default means
      // `req.fallback` — today's non-interactive behaviour at each site, stated by the site itself.
      if (ask === undefined) return previous?.decide(req, ask) ?? req.fallback;

      // Matched EXACTLY against the options offered, never by prefix. A prefix test is what a select
      // whose labels share a word cannot survive: "Allow" and "Always allow …" both begin with "a", so
      // `startsWith('a')` read a plain one-off Allow as an instruction to remember it — silently
      // granting standing permission a user never asked for, which is precisely the thing this policy
      // must not get wrong. The CLI resolves a typed prefix to the full label before it returns, and a
      // rich frontend sends the label it rendered, so an exact match is what both actually produce.
      //
      // The per-subject "always" is listed BEFORE the blanket one so a CLI user typing "alw" lands on
      // the narrower choice. The default follows `fallback`, so a site whose non-interactive answer is
      // "proceed" (tools.overwrite) keeps proceeding for a frontend that can only answer with a default.
      const allowOnce     = 'Allow';
      const alwaysSubject = `Always allow "${req.subject}"`;
      const alwaysGate    = `Always allow every ${req.gate}`;
      const field: FormField = {
        name:    'gate',
        label:   req.label,
        type:    'select',
        options: ['Deny', allowOnce, alwaysSubject, alwaysGate],
        default: req.fallback ? allowOnce : 'Deny',
      };
      const answer = (await ask(field)).trim().toLowerCase();
      const is = (option: string): boolean => answer === option.toLowerCase();

      if (is(alwaysGate))    { await remember(req.gate, true); return true; }
      if (is(alwaysSubject)) {
        // Persist the list IN EFFECT plus this subject, never the subject alone: the list in effect may
        // come from `default_settings`, and a stored key wins over the floor wholesale — writing
        // `[subject]` would silently start asking again about everything the install had exempted.
        const current  = await read(req.gate);
        const subjects = current === undefined || current === true ? [req.subject] : [...new Set([...current, req.subject])];
        await remember(req.gate, subjects);
        return true;
      }
      // Deny, an empty answer a frontend resolved to neither label, or anything unrecognised: permission
      // is what has to be given, so only the two allow answers grant it — and neither remembers a thing.
      return is(allowOnce);
    },
  };
}

/** The gate ids matbot's own privileged call sites declare. Not a closed set — a gate id is open at
 *  runtime, and one this build never compiled against must default to asking — but a vocabulary the
 *  `gate_action` tool can report on without waiting for a gate to be reached for the first time. */
export const KNOWN_GATES: readonly string[] = [
  'tools.overwrite',
  'plugin.add', 'plugin.provision-deps', 'plugin.remove', 'plugin.npm-uninstall', 'plugin.load',
  'provider.add', 'provider.add-unverified', 'provider.update', 'provider.update-unverified', 'provider.remove',
  'mcp_action.add', 'mcp_action.remove',
];

/** Settings key holding the gate ids this policy has written a standing answer for. `PluginSettings`
 *  has no enumeration, and a gate id contributed by a plugin this build never saw is exactly the one
 *  {@link KNOWN_GATES} cannot name — so `gate_action` would otherwise be unable to report, or clear,
 *  an answer the user gave. Dunder-prefixed: it is this policy's bookkeeping, not a gate id. */
export const WRITTEN_GATES_KEY = '__gates__';
