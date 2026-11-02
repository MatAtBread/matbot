import { FORM_AXIS_SEPARATOR, permitted, refused, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { FormField, FormOption, PermissionContext, PermissionDecision, PermissionGate, PermissionRequest, PluginSettings } from '@matatbread/matbot-plugin-api';

/** The settings namespace standing answers live in, and what an installation keys `default_settings:`
 *  by. The name of the package this policy was published as before it moved into core: stored answers
 *  and every installation's yaml are keyed by it, so it stays. Nothing loads under it, so
 *  `assembleMachine` exempts it from the "names no loaded plugin" warning. */
export const DEFAULT_GATE_SETTINGS_NS = '@matatbread/matbot-default-gate';

/**
 * A standing answer for one gate id in one scope: `true` — every subject; a list — exactly these subjects
 * (and, where the call site declares a hierarchy, what lies beneath them).
 */
export type StandingAnswer = true | readonly string[];

/**
 * A gate's standing answers by SCOPE — the key a {@link PermissionContext} is matched against:
 * {@link EVERYWHERE}, a session id, or a `#` sentinel for a door with no session of its own (`#http`).
 *
 *   'tool_function.import': { '*': ['* node:os'], '<session id>': ['probe /home/me/photos/'] }
 *
 * Always a map, even for an answer held everywhere: one shape, so a reader never guesses which a value is.
 */
export type ScopedAnswers = ReadonlyMap<string, StandingAnswer>;

/** The scope of an answer held wherever it is asked — every session, every door. */
export const EVERYWHERE = '*';

/**
 * The policy's own option choosing where a "for this session" answer given at a prompt is kept: `memory`
 * (the default — gone at restart, and out of reach of every tool, being in no file) or `settings` (beside
 * the `always` answers, under the session's id; kept until forgotten, sessions being kept for ever).
 * Persisted session answers are honoured either way, so an installation can configure some.
 *
 * Keys starting `#` are this policy's options: no gate id can start with one (a gate id is `<tool>.<gate>`).
 */
export const SESSION_STORE_KEY = '#session-store';
export const isPolicyOption = (key: string): boolean => key.startsWith('#');

/**
 * Where a gate's standing DENIALS live: beside its allows, under a key no gate id can have (a gate id is
 * `<tool>.<gate>`, and a tool name has no `:`), in the same scoped shape.
 */
export const denyKey = (gate: string): string => `deny:${gate}`;

/** Boundary check on a value out of config or a store — neither is typed, and a malformed one must not
 *  read as `true` (every subject allowed, no prompt, no trace of why). Anything unrecognised asks. */
export function toStandingAnswer(value: unknown): StandingAnswer | undefined {
  if (value === true) return true;
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  return undefined;
}

/** The format before scopes: a list, or `true`, straight under the gate id. */
export const isUnscoped = (value: unknown): boolean => value === true || Array.isArray(value);

/** A gate key's value as {@link ScopedAnswers}, or `undefined` when it is not one — absent, malformed, or in
 *  the unscoped format, which is not read as an answer: see {@link warnUnscoped}. */
export function toScopedAnswers(value: unknown): ScopedAnswers | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = new Map<string, StandingAnswer>();
  for (const [scope, held] of Object.entries(value)) {
    const answer = toStandingAnswer(held);
    if (answer !== undefined) out.set(scope, answer);
  }
  return out;
}

const warned = new Set<string>();
/**
 * An unscoped value is ignored, and said so once per key. A stored one is migrated before anything reads it,
 * so one that reaches here was configured (`default_settings:`) — where a denial ignored in silence would be
 * an installation's refusal quietly no longer applying.
 */
function warnUnscoped(key: string, value: unknown): void {
  if (!isUnscoped(value) || warned.has(key)) return;
  warned.add(key);
  console.warn(`[matbot] Permission answer "${key}" is in the unscoped format (a list or true) and is ignored. ` +
               `Write it as { "${EVERYWHERE}": ${JSON.stringify(value)} } — in default_settings for '${DEFAULT_GATE_SETTINGS_NS}' if it is configured there.`);
}

/** A gate key's value read for a decision: scoped, or warned about and treated as absent. */
function scopedOf(key: string, value: unknown): ScopedAnswers | undefined {
  warnUnscoped(key, value);
  return toScopedAnswers(value);
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

/** `answer` with `subject` added — `true` already covers it, and adding `true` covers everything. */
function adding(answer: StandingAnswer | undefined, subject: string | true): StandingAnswer {
  if (subject === true || answer === true) return true;
  return [...new Set([...(answer ?? []), subject])];
}

// ── Session answers held in memory ────────────────────────────────────────────
// principal → session → settings key (a gate id, or its deny key) → answer. Module-scoped like `serialised`,
// so `gate_action` sees what any instance remembered. Keyed by principal because a session can be shared,
// and an answer one principal gave for their work is not one another principal gave.

const memory = new Map<string, Map<string, Map<string, StandingAnswer>>>();
const principalKey = (): string => { const p = tryCurrentPrincipal(); return p !== undefined ? `${p.type}:${p.id}` : ''; };

/** This principal's session answers held in memory: session → settings key → answer. Live, not a copy. */
export function sessionMemory(): Map<string, Map<string, StandingAnswer>> {
  const who = principalKey();
  let mine = memory.get(who);
  if (mine === undefined) { mine = new Map(); memory.set(who, mine); }
  return mine;
}

/**
 * Move this principal's session answers out of memory into settings, under each session's id — what
 * switching `#session-store` to `settings` means for the answers already given, which would otherwise end
 * at the next restart despite the switch. Merged into what settings hold, inside the write queue. Returns
 * how many answers (session × key) moved.
 */
export function persistSessionMemory(settings: PluginSettings): Promise<number> {
  return serialised(async () => {
    const sessions = sessionMemory();
    let moved = 0;
    for (const [session, keys] of sessions) {
      for (const [key, answer] of keys) {
        const current = new Map(toScopedAnswers(await settings.get<unknown>(key)));
        current.set(session, answer === true ? true : answer.reduce<StandingAnswer>(adding, current.get(session) ?? []));
        await settings.set(key, Object.fromEntries(current));
        moved++;
      }
    }
    sessions.clear();
    return moved;
  });
}

/**
 * Add `subject` to the answers stored under `key` in `scope`, inside the write queue.
 *
 * Re-read INSIDE the queue: the answers may have grown since the prompt was rendered (a concurrent answer,
 * given first). Persist the answers IN EFFECT plus this one, never this one alone — they may come from
 * `default_settings`, and a stored key wins over the floor wholesale, so writing just the new subject would
 * silently start asking again about everything the install had exempted.
 */
export function rememberStanding(settings: PluginSettings, key: string, scope: string, subject: string | true): Promise<void> {
  return serialised(async () => {
    const current = new Map(toScopedAnswers(await settings.get<unknown>(key)));
    current.set(scope, adding(current.get(scope), subject));
    await settings.set(key, Object.fromEntries(current));
  });
}

function rememberInMemory(session: string, key: string, subject: string | true): void {
  const sessions = sessionMemory();
  let keys = sessions.get(session);
  if (keys === undefined) { keys = new Map(); sessions.set(session, keys); }
  keys.set(key, adding(keys.get(key), subject));
}

/**
 * The scopes an answer is looked up in for this context, most specific first: the context's session, then
 * everywhere. `*` holds everywhere — a `#http` call is covered by an answer given for every door.
 */
function scopesFor(context: PermissionContext): string[] {
  return context.session !== undefined && context.session !== EVERYWHERE ? [context.session, EVERYWHERE] : [EVERYWHERE];
}

/** A session someone works in, so one a "for this session" answer can be given for — not a door sentinel. */
const workable = (session: string | undefined): session is string =>
  session !== undefined && session !== EVERYWHERE && !session.startsWith('#');

/** The scoped answers for one key in this context: what settings hold, with this session's memory merged in. */
function inEffect(stored: ScopedAnswers | undefined, key: string, context: PermissionContext, held: Map<string, Map<string, StandingAnswer>>): ScopedAnswers | undefined {
  if (context.session === undefined) return stored;
  const remembered = held.get(context.session)?.get(key);
  if (remembered === undefined) return stored;
  const merged = new Map(stored);
  const persisted = merged.get(context.session) ?? [];
  merged.set(context.session, remembered === true ? true : remembered.reduce<StandingAnswer>(adding, persisted));
  return merged;
}

/**
 * The standing answer in force for `req`, or `undefined` when nothing stored or configured covers it — one
 * rule for {@link PermissionGate.decide} and {@link PermissionGate.snapshot}, which differ only in how `read`
 * reaches the answers.
 *
 * MOST SPECIFIC wins, which needs no parsing of a subject: the call site lists the act's subjects narrowest
 * first ({@link PermissionRequest.standing}), and a stored subject covers one exactly, or as a prefix ending at a
 * declared separator. A match is ranked by
 *   1. how far BELOW the stored subject the nearest subject it covers lies — 0 for an exact match, otherwise
 *      the depth of prefix between them — so a deeper answer beats a shallower one whichever subjects they
 *      reach; `true` (every subject) is farthest of all;
 *   2. then the earliest of the call site's subjects at that distance;
 *   3. then this session's answer before one held everywhere;
 *   4. then a denial before an allow — a tie that should not arise, and is refused if it does.
 * So an allow of `* node:fs` beside a denial of `* node:` admits `node:fs` and nothing else under `node:`, a
 * denial of one file or subdirectory carves it out of a directory granted to any function or to one, and an
 * allow of one function's directory reopens it inside a denial for every function. The distance comes first
 * because the subjects of a hierarchical gate vary along two axes (which function, how deep a path), and a
 * stored ancestor directory is not among them: ranked by the earliest subject it covered, a grant of a whole
 * tree to one function covered that function's exact file, and so outranked a denial of the file for every
 * function — the denial a user writes to exclude one file from what they granted. For a gate without
 * separators every match is exact, and the order is the call site's alone.
 *
 * A request that permits no lifetime ({@link PermissionRequest.lifetimes} empty) is asked every time: no
 * standing answer decides it, stored or configured.
 *
 * A session's answer is reported as `session`; one held everywhere or at a door as `configuration` — settings
 * reads are layered, so a configured floor and a remembered answer cannot be told apart, and claiming `user`
 * for either would be a lie half the time.
 */
function standingDecision(read: (key: string) => ScopedAnswers | undefined, req: PermissionRequest, context: PermissionContext): PermissionDecision | undefined {
  if (req.lifetimes?.length === 0) return undefined;
  const scopes     = scopesFor(context);
  const candidates = [req.subject, ...(req.standing ?? []).map(o => o.subject)];
  const separators = (req.separators ?? []).filter(sep => sep !== '');
  const covers = (stored: string, c: string): boolean =>
    c === stored || (separators.some(sep => stored.endsWith(sep)) && c.startsWith(stored));

  interface Match { distance: number; at: number; scope: number; deny: boolean }
  const before = (a: Match, b: Match): boolean =>
      a.distance !== b.distance ? a.distance < b.distance
    : a.at       !== b.at       ? a.at < b.at
    : a.scope    !== b.scope    ? a.scope < b.scope
    : a.deny && !b.deny;

  let best: Match | undefined;
  for (const deny of [true, false]) {
    const held = read(deny ? denyKey(req.gate) : req.gate);
    if (held === undefined) continue;
    scopes.forEach((scope, i) => {
      const answer = held.get(scope);
      if (answer === undefined) return;
      const found = answer === true
        ? [{ distance: Infinity, at: candidates.length }]
        : answer.flatMap(stored => {
            let nearest: { distance: number; at: number } | undefined;
            candidates.forEach((c, at) => {
              if (!covers(stored, c)) return;
              const distance = c.length - stored.length;
              if (nearest === undefined || distance < nearest.distance) nearest = { distance, at };
            });
            return nearest !== undefined ? [nearest] : [];
          });
      for (const m of found) {
        const match = { ...m, scope: i, deny };
        if (best === undefined || before(match, best)) best = match;
      }
    });
  }
  if (best === undefined) return undefined;
  const source = workable(scopes[best.scope]) ? 'session' : 'configuration';
  return best.deny ? refused(source) : permitted(source);
}

// ── The prompt ────────────────────────────────────────────────────────────────

/** The lifetimes a prompt can remember an answer for, beside "this time". */
type Remembered = 'session' | 'always';

/** What may be remembered here: what the call site permits, of what this policy implements, and a session
 *  only where there is one somebody is working in. */
function lifetimesFor(req: PermissionRequest, context: PermissionContext): Remembered[] {
  const permits = req.lifetimes ?? ['session', 'always'];
  return (['session', 'always'] as const).filter(l => permits.includes(l) && (l !== 'session' || workable(context.session)));
}

const EVERY = 'every';
// In axis order — what, for how long, then allow or deny — so a frontend drawing the last as buttons reads
// as a phrase ending in its verb: [requests to https://x ▾] [for this session ▾] [Allow] [Deny].
const encode = (effect: 'allow' | 'deny', lifetime: 'once' | Remembered, subject: string): string =>
  [subject, lifetime, effect].join(FORM_AXIS_SEPARATOR);

/**
 * The prompt: three independent choices — subject, lifetime, effect — as `axes` for a frontend that renders
 * one control each (the effect as the buttons that answer), and as a short flat list of the common
 * combinations for one that renders only buttons.
 *
 * Every option carries a VALUE distinct from its label, and the answer is matched against values. A label is
 * cosmetic — rendered, rewordable, localisable — so using it as the identity is what once let a prefix test
 * read "Allow" as "Always allow …" and grant standing permission nobody gave.
 *
 * The subjects are the call site's, narrowest first, labelled in its words: a label names WHAT, and the
 * policy words how long ("Always allow …", "Allow … for this session"). The order is load-bearing in the
 * flat list too: a frontend resolving a typed prefix to the first match lands on the narrowest answer.
 */
function promptFor(req: PermissionRequest, context: PermissionContext): { field: FormField; subjects: readonly string[]; lifetimes: readonly Remembered[] } {
  const offered = req.standing !== undefined && req.standing.length > 0 ? [...req.standing] : [];
  // The exact act can always be remembered — it is what was asked about — so it is offered even where the
  // call site's list left it out.
  if (!offered.some(o => o.subject === req.subject)) offered.unshift({ subject: req.subject, label: `"${req.subject}"` });
  const exact     = String(offered.findIndex(o => o.subject === req.subject));
  const lifetimes = lifetimesFor(req, context);
  const session   = lifetimes.includes('session');
  const always    = lifetimes.includes('always');
  const yes = req.answers?.yes ?? 'Allow';
  const no  = req.answers?.no  ?? 'Deny';
  const firstly = encode(req.fallback ? 'allow' : 'deny', 'once', exact);

  // Nothing can be remembered, so there is nothing to choose but yes or no: no subject, no lifetime — both
  // only say what would be STORED, and a subject is a key (`deny:tool_function.fs-read * /p/.env`) that
  // reads as noise beside a question that already names the act. Plain options, which every frontend draws
  // as buttons.
  if (req.lifetimes?.length === 0) {
    const field: FormField = {
      name: 'gate', label: req.label, type: 'select', default: firstly,
      options: [{ value: encode('allow', 'once', exact), label: yes }, { value: encode('deny', 'once', exact), label: no }],
    };
    return { field, subjects: offered.map(o => o.subject), lifetimes };
  }

  const subjects: FormOption[] = [
    ...offered.map((o, i) => ({ value: String(i), label: o.label })),
    { value: EVERY, label: `every ${req.gate}` },
  ];
  const options: FormOption[] = [
    { value: encode('deny', 'once', exact), label: no },
    ...(session ? [{ value: encode('deny', 'session', exact), label: 'Deny for this session' }] : []),
    ...(always  ? [{ value: encode('deny', 'always',  exact), label: 'Always deny' }] : []),
    { value: encode('allow', 'once', exact), label: yes },
    ...offered.flatMap((o, i) => [
      ...(session ? [{ value: encode('allow', 'session', String(i)), label: `Allow ${o.label} for this session` }] : []),
      ...(always  ? [{ value: encode('allow', 'always',  String(i)), label: `Always allow ${o.label}` }] : []),
    ]),
    ...(always ? [{ value: encode('allow', 'always', EVERY), label: `Always allow every ${req.gate}` }] : []),
  ];
  const field: FormField = {
    name:    'gate',
    label:   req.label,
    type:    'select',
    options,
    axes: [
      { name: 'subject', label: req.gate, options: subjects },
      { name: 'lifetime', options: [
        { value: 'once', label: 'this time' },
        ...(session ? [{ value: 'session', label: 'for this session' }] : []),
        ...(always  ? [{ value: 'always',  label: 'always' }] : []),
      ] },
      { name: 'effect', submit: true, options: [{ value: 'allow', label: yes }, { value: 'deny', label: no }] },
    ],
    // A site whose non-interactive answer is "proceed" (tools.overwrite) keeps proceeding for a frontend that
    // can only answer with the default.
    default: firstly,
  };
  return { field, subjects: offered.map(o => o.subject), lifetimes };
}

/** An answer, checked against what was OFFERED — never taken from the answer text: a policy that stored an
 *  arbitrary string back would let a call site widen every other gate's memory by what it puts in one field.
 *  `undefined` for anything that is not one of the combinations rendered. */
function decode(answer: string, subjects: readonly string[], lifetimes: readonly Remembered[]):
    { effect: 'allow' | 'deny'; lifetime: 'once' | Remembered; subject: string | true } | undefined {
  const [subject, lifetime, effect, ...rest] = answer.trim().toLowerCase().split(FORM_AXIS_SEPARATOR);
  if (rest.length > 0 || (effect !== 'allow' && effect !== 'deny')) return undefined;
  if (lifetime !== 'once' && !lifetimes.includes(lifetime as Remembered)) return undefined;
  if (subject === EVERY) return { effect, lifetime: lifetime as 'once' | Remembered, subject: true };
  const i = subject !== undefined && /^\d+$/.test(subject) ? Number(subject) : -1;
  const chosen = subjects[i];
  return chosen === undefined ? undefined : { effect, lifetime: lifetime as 'once' | Remembered, subject: chosen };
}

// ── The policy ────────────────────────────────────────────────────────────────

// Each policy's migration, by the settings it was built over, so `gate_action` — built separately, over the
// same settings — reads nothing still in the old format either: the first thing asked after an upgrade may
// well be what the policy remembers.
const migrations = new WeakMap<PluginSettings, () => Promise<void>>();
export const migratedFor = (settings: PluginSettings): Promise<void> => migrations.get(settings)?.() ?? Promise.resolve();

/**
 * The policy that reproduces matbot's historical behaviour, generalised from tool names to
 * `(gate, subject)` and given lifetimes: ask, offer standing answers for this session or always, remember
 * them. It keeps its own settings namespace, out of the reserved `__matbot_core__`, and sits behind the
 * `PermissionGate` seam, so an installation can *replace* a policy rather than defeat one.
 *
 * Storage is one key per gate id, holding {@link ScopedAnswers}, so an install authors the floor the
 * ordinary way and needs no tooling of its own:
 *
 *   default_settings:
 *     '@matatbread/matbot-default-gate':
 *       'tools.overwrite': { '*': [bash, plugin] }
 *
 * `previous` is whatever gate this one displaced (the host's asking default, in the normal case). It
 * is delegated to when there is nobody to ask — the one case this policy has nothing to add to, and
 * the capture-and-delegate idiom that makes two gates compose in either load order.
 *
 * `stored` reads the namespace's stored document alone, for the one-off migration of answers written in the
 * unscoped format: read from the stored document, so a configured default is never copied into it. Without
 * it nothing is migrated, and an unscoped stored answer is ignored and warned about like a configured one.
 */
export function createDefaultGate(settings: PluginSettings, previous?: PermissionGate, stored?: () => Promise<Record<string, unknown>>): PermissionGate {
  // Once per principal, settings being partitioned by principal where a backend does that. Awaited by every
  // read, so nothing decides on a document still in the old format. A failure is reported and not retried
  // per call — the unscoped answers then fall to the warning, which says what to do.
  const migratedBy = new Map<string, Promise<void>>();
  const migrated = (): Promise<void> => {
    if (stored === undefined) return Promise.resolve();
    const who = principalKey();
    let done = migratedBy.get(who);
    if (done === undefined) {
      done = serialised(async () => {
        for (const [key, value] of Object.entries(await stored())) {
          if (!isPolicyOption(key) && isUnscoped(value)) await settings.set(key, { [EVERYWHERE]: value });
        }
      }).catch(e => { console.warn(`[matbot] Could not migrate standing permission answers: ${e instanceof Error ? e.message : String(e)}`); });
      migratedBy.set(who, done);
    }
    return done;
  };
  if (stored !== undefined) migrations.set(settings, migrated);

  const fallback = (req: PermissionRequest): PermissionDecision =>
    req.fallback ? permitted('fallback') : refused('fallback');

  return {
    // One `entries()` read — the whole namespace, layered over the configured floor — and this session's
    // memory as it stands, so the returned function consults only what was read. The displaced gate's
    // snapshot is taken beside it, so a nothing-stored answer delegates exactly as `decide` does.
    async snapshot(context) {
      await migrated();
      const [entries, before] = await Promise.all([settings.entries(), previous?.snapshot(context)]);
      const held = new Map([...sessionMemory()].map(([s, keys]) => [s, new Map(keys)]));
      const read = (key: string): ScopedAnswers | undefined => inEffect(scopedOf(key, entries[key]), key, context, held);
      return req => standingDecision(read, req, context) ?? before?.(req) ?? fallback(req);
    },

    async decide(req, ask, context) {
      await migrated();
      const keys = [req.gate, denyKey(req.gate)];
      const values = await Promise.all(keys.map(k => settings.get<unknown>(k)));
      const held = sessionMemory();
      const answers = new Map(keys.map((k, i) => [k, inEffect(scopedOf(k, values[i]), k, context, held)]));
      const known = standingDecision(k => answers.get(k), req, context);
      if (known !== undefined) return known;

      // Nothing stored and nobody to ask: the displaced gate answers, which for the host default means
      // `req.fallback` — today's non-interactive behaviour at each site, stated by the site itself.
      // The predecessor's own source rides back out: it is the layer that answered, and rewriting it
      // here would erase the one fact `source` carries.
      if (ask === undefined) return previous !== undefined ? previous.decide(req, ask, context) : fallback(req);

      const { field, subjects, lifetimes } = promptFor(req, context);
      const chosen = decode(await ask(field), subjects, lifetimes);
      // An answer a frontend resolved to no option, or anything unrecognised: permission is what has to be
      // given, so it is a refusal.
      if (chosen === undefined) return refused('user');
      const { effect, lifetime, subject } = chosen;
      const key = effect === 'deny' ? denyKey(req.gate) : req.gate;
      if (lifetime === 'session') {
        // `lifetimesFor` offers a session only where `workable` holds.
        const session = context.session!;
        if (await settings.get<unknown>(SESSION_STORE_KEY) === 'settings') await rememberStanding(settings, key, session, subject);
        else rememberInMemory(session, key, subject);
      } else if (lifetime === 'always') {
        await rememberStanding(settings, key, EVERYWHERE, subject);
      }
      return effect === 'allow' ? permitted('user') : refused('user');
    },
  };
}
