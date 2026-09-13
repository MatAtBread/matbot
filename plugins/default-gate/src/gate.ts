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

  // One write, and the store is the only record: `settings.entries()` enumerates the namespace, so
  // there is nothing to index. This used to keep its own list of ids it had written — a second copy of
  // its own keyspace, which could not see a configured default, and which a crash between the two
  // writes left behind as a standing answer in force and invisible to both `get` and `clear`.
  //
  // Serialised, because appending a subject is a read-modify-write and `PluginSettings` has no CAS:
  // `set` guards the document, not the value that was read out of it, so two collisions answered at
  // once would both read the same list and the second write would drop the first's subject. A silently
  // lost permission is a prompt that reappears (benign) — but a lost *revocation* would be the mirror,
  // and neither belongs in this component. One in-process queue closes it; two matbot processes
  // sharing one medium remain last-write-wins, which is the store's contract to change, not ours.
  let writes: Promise<unknown> = Promise.resolve();
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work, work);
    writes = next.catch(() => {});
    return next;
  };

  return {
    async decide(req, ask) {
      if (allows(await read(req.gate), req.subject)) return true;

      // Nothing stored and nobody to ask: the displaced gate answers, which for the host default means
      // `req.fallback` — today's non-interactive behaviour at each site, stated by the site itself.
      if (ask === undefined) return previous?.decide(req, ask) ?? req.fallback;

      // Each option carries a VALUE distinct from its label, and the answer is matched against the
      // value. A label is cosmetic — rendered, rewordable, localisable — so using it as the identity
      // is what let a prefix test read "Allow" as "Always allow …" and grant standing permission
      // nobody gave. `confirm` has always worked this way (CONFIRM_YES/NO are tokens, not labels).
      //
      // The per-subject "always" is listed BEFORE the blanket one so a CLI user typing "alw" lands on
      // the narrower choice. The default names a value, so a site whose non-interactive answer is
      // "proceed" (tools.overwrite) keeps proceeding for a frontend that can only answer with it.
      const ALLOW_ONCE = 'allow', ALWAYS_SUBJECT = 'always-subject', ALWAYS_GATE = 'always-gate';
      const field: FormField = {
        name:    'gate',
        label:   req.label,
        type:    'select',
        options: [
          { value: 'deny',          label: 'Deny' },
          { value: ALLOW_ONCE,      label: 'Allow' },
          { value: ALWAYS_SUBJECT,  label: `Always allow "${req.subject}"` },
          { value: ALWAYS_GATE,     label: `Always allow every ${req.gate}` },
        ],
        default: req.fallback ? ALLOW_ONCE : 'deny',
      };
      const answer = (await ask(field)).trim().toLowerCase();

      if (answer === ALWAYS_GATE) { await serialised(() => settings.set(req.gate, true)); return true; }
      if (answer === ALWAYS_SUBJECT) {
        await serialised(async () => {
          // Re-read INSIDE the queue: the list may have grown since this prompt was rendered (a
          // concurrent collision, answered first). Persist the list IN EFFECT plus this subject, never
          // the subject alone — the list in effect may come from `default_settings`, and a stored key
          // wins over the floor wholesale, so writing `[subject]` would silently start asking again
          // about everything the install had exempted.
          const current  = await read(req.gate);
          const subjects = current === undefined || current === true ? [req.subject] : [...new Set([...current, req.subject])];
          await settings.set(req.gate, subjects);
        });
        return true;
      }
      // Deny, an answer a frontend resolved to no option, or anything unrecognised: permission is what
      // has to be given, so only the two allow answers grant it — and a plain Allow remembers nothing.
      return answer === ALLOW_ONCE;
    },
  };
}
