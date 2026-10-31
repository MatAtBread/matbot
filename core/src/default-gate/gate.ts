import { permitted, refused, type FormField, type PermissionGate, type PluginSettings } from '@matatbread/matbot-plugin-api';

/** The settings namespace standing answers live in, and what an installation keys `default_settings:`
 *  by. The name of the package this policy was published as before it moved into core: stored answers
 *  and every installation's yaml are keyed by it, so it stays. Nothing loads under it, so
 *  `assembleMachine` exempts it from the "names no loaded plugin" warning. */
export const DEFAULT_GATE_SETTINGS_NS = '@matatbread/matbot-default-gate';

/**
 * A standing answer for one gate id: `true` — every subject; a list — exactly these subjects; absent (or
 * anything else) — ask. Stored under the gate id for an allow, and under {@link denyKey} for a deny.
 */
export type StandingAnswer = true | readonly string[];

/**
 * Where a gate's standing DENIALS live: beside its allows, under a key no gate id can have (a gate id is
 * `<tool>.<gate>`, and a tool name has no `:`), so the allow keys keep the format they always had and a
 * reader that predates denials sees nothing it misreads as one.
 *
 * Only the exact subject is ever stored from a prompt: "Always deny" is offered for the act being asked
 * about and nothing broader, because a deny is for the request a model keeps making, and one button is
 * the price of it. An installation can configure a list, or `true` for every subject, under
 * `default_settings:` like any other key. A denial wins over an allow that also covers the act — which
 * matters only where a deny was stored first and a broader allow given after, or both are configured,
 * since an allow covering the act would have kept it from being asked about again.
 */
export const denyKey = (gate: string): string => `deny:${gate}`;

/** Boundary check on a value out of config or a store — neither is typed, and a malformed one must not
 *  read as `true` (every subject allowed, no prompt, no trace of why). Anything unrecognised asks. */
export function toStandingAnswer(value: unknown): StandingAnswer | undefined {
  if (value === true) return true;
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  return undefined;
}

/**
 * Serialises every standing-answer write by this policy — the gate's and `gate_action`'s — across
 * gate instances.
 *
 * Appending a subject is a read-modify-write and `PluginSettings` has no CAS on a value — `set` guards
 * the document, not the list that was read out of it — so two answers given at once would both read the
 * same list and the second would drop the first's subject. Module-scoped rather than per instance
 * because instances multiply on purpose: the host seeds one, and a policy that displaces it composes by
 * building another over the same settings (the documented `createDefaultGate(settings, previous)`), at
 * which point a per-instance queue serialises each against itself and neither against the other.
 *
 * One queue for every namespace is the cheap end of the trade — these writes happen when a human
 * answers a prompt, so contention is measured in single-digit writes per session. What remains outside
 * it is what a queue cannot reach: a second process over the same medium, and a hot-reloaded second
 * copy of this module. Both are last-write-wins, which is the store's contract to change, not ours.
 */
let writes: Promise<unknown> = Promise.resolve();
export function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.catch(() => {});
  return next;
}

/**
 * Whether a standing answer covers this act — the exact subject, or any broader subject the call site
 * offered as a {@link PermissionRequest.standing} answer offered by the call site.
 *
 * Set membership over strings this policy never parses: the call site enumerates how its own subjects
 * generalise, so `node:` admits `node:fs` here without this module knowing what a module specifier is,
 * and a gate contributed by a plugin this build never saw generalises on the same terms.
 */
const allows = (answer: StandingAnswer | undefined, subject: string, standing: readonly { subject: string }[] = []): boolean =>
  answer === true || (answer !== undefined && [subject, ...standing.map(o => o.subject)].some(s => answer.includes(s)));

/**
 * The policy that reproduces matbot's historical behaviour, generalised from tool names to
 * `(gate, subject)`: ask, offer standing answers, remember them. It keeps its own settings namespace,
 * out of the reserved `__matbot_core__`, and sits behind the `PermissionGate` seam, so an installation
 * can *replace* a policy rather than defeat one.
 *
 * Storage is one key per gate id, holding a {@link StandingAnswer}, in its own settings
 * namespace — so an install authors the floor the ordinary way and needs no tooling of its own:
 *
 *   default_settings:
 *     '@matatbread/matbot-default-gate':
 *       'tools.overwrite': [bash, plugin]
 *
 * `previous` is whatever gate this one displaced (the host's asking default, in the normal case). It
 * is delegated to when there is nobody to ask — the one case this policy has nothing to add to, and
 * the capture-and-delegate idiom that makes two gates compose in either load order.
 */
export function createDefaultGate(settings: PluginSettings, previous?: PermissionGate): PermissionGate {
  const read = async (gate: string): Promise<StandingAnswer | undefined> =>
    toStandingAnswer(await settings.get<unknown>(gate));

  // Re-read INSIDE the write queue: the list may have grown since the prompt was rendered (a concurrent
  // collision, answered first). Persist the list IN EFFECT plus this subject, never the subject alone — the
  // list in effect may come from `default_settings`, and a stored key wins over the floor wholesale, so
  // writing `[subject]` would silently start asking again about everything the install had exempted.
  const remember = async (key: string, subject: string): Promise<void> => {
    const current  = toStandingAnswer(await settings.get<unknown>(key));
    const subjects = current === undefined || current === true ? [subject] : [...new Set([...current, subject])];
    await settings.set(key, subjects);
  };

  // A standing answer is one write, and the store is the only record: `settings.entries()` enumerates
  // the namespace, so there is nothing to index. This used to keep its own list of ids it had written —
  // a second copy of its own keyspace, which could not see a configured default, and which a crash
  // between the two writes left behind as an answer in force and invisible to both `get` and `clear`.
  return {
    async decide(req, ask) {
      const standing = req.standing ?? [];
      // A standing answer is `configuration` whether it came from `default_settings:` or from a
      // "always allow" a human gave earlier — settings reads are layered, so nothing here can tell
      // the two apart, and a source that claimed `user` for a configured floor would be a lie half
      // the time. What a reader needs is that this was decided in advance, not at this prompt.
      // Denied first: a denial wins over an allow that also covers the act. Exact subject only — a
      // denial is never generalised by the call site's broader standing subjects.
      if (allows(await read(denyKey(req.gate)), req.subject)) return refused('configuration');
      if (allows(await read(req.gate), req.subject, standing)) return permitted('configuration');

      // Nothing stored and nobody to ask: the displaced gate answers, which for the host default means
      // `req.fallback` — today's non-interactive behaviour at each site, stated by the site itself.
      // The predecessor's own source rides back out: it is the layer that answered, and rewriting it
      // here would erase the one fact `source` carries.
      if (ask === undefined) {
        return previous !== undefined
          ? previous.decide(req, ask)
          : req.fallback ? permitted('fallback') : refused('fallback');
      }

      // Each option carries a VALUE distinct from its label, and the answer is matched against the
      // value. A label is cosmetic — rendered, rewordable, localisable — so using it as the identity
      // is what let a prefix test read "Allow" as "Always allow …" and grant standing permission
      // nobody gave. `confirm` has always worked this way (CONFIRM_YES/NO are tokens, not labels).
      //
      // The per-subject "always" is listed BEFORE the blanket one so a CLI user typing "alw" lands on
      // the narrower choice. The default names a value, so a site whose non-interactive answer is
      // "proceed" (tools.overwrite) keeps proceeding for a frontend that can only answer with it.
      // One option per standing answer the call site offered, in the order it gave — narrowest first. The
      // ordering is load-bearing beyond cosmetics: a frontend that resolves a typed prefix to the first
      // matching option lands on the narrowest answer, which is why broader ones are never above it.
      //
      // The label is the call site's, rendered and never rewritten, exactly as `req.label` is. With none
      // offered this falls back to naming the subject, which is right for a gate whose subject is already
      // prose a human recognises (`@x/foo` for `plugin.add`) and is all a policy can honestly do.
      // "Always deny" sits beside Deny and names nothing: the question above it already states the exact
      // act, which is all it covers. The policy's own words, like "Always allow every …".
      const ALLOW_ONCE = 'allow', ALWAYS_GATE = 'always-gate', DENY_ALWAYS = 'deny-always';
      const offers = standing.length > 0
        ? standing
        : [{ subject: req.subject, label: `Always allow "${req.subject}"` }];
      const always = offers.map((o, i) => ({ value: `always-${i}`, label: o.label, subject: o.subject }));
      const field: FormField = {
        name:    'gate',
        label:   req.label,
        type:    'select',
        options: [
          { value: 'deny',      label: 'Deny' },
          { value: DENY_ALWAYS, label: 'Always deny' },
          { value: ALLOW_ONCE,  label: 'Allow' },
          ...always.map(({ value, label }) => ({ value, label })),
          { value: ALWAYS_GATE, label: `Always allow every ${req.gate}` },
        ],
        default: req.fallback ? ALLOW_ONCE : 'deny',
      };
      const answer = (await ask(field)).trim().toLowerCase();

      if (answer === ALWAYS_GATE) { await serialised(() => settings.set(req.gate, true)); return permitted('user'); }
      if (answer === DENY_ALWAYS) {
        await serialised(() => remember(denyKey(req.gate), req.subject));
        return refused('user');
      }
      // Only a subject that was OFFERED can be stored: the remembered value is looked up in the options
      // this prompt rendered, never taken from the answer text. A policy that stored an arbitrary string
      // back would let a call site widen every other gate's memory by what it puts in one field.
      const chosen = always.find(a => a.value === answer)?.subject;
      if (chosen !== undefined) {
        await serialised(() => remember(req.gate, chosen));
        return permitted('user');
      }
      // Deny, an answer a frontend resolved to no option, or anything unrecognised: permission is what
      // has to be given, so only the two allow answers grant it — and a plain Allow remembers nothing.
      return answer === ALLOW_ONCE ? permitted('user') : refused('user');
    },
  };
}
