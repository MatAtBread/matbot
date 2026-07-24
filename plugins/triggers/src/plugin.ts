import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, Store, Message, MessageContent, Session, PromptFn, DeferredCorrection } from '@matatbread/matbot-plugin-api';
import { TriggerManager } from './manager.js';
import { dispatchTrigger, renderResult } from './dispatch.js';
import { createTriggerActionTool, createTriggersConfigTool } from './tools.js';
import type { Trigger, Triggers, FiredCondition } from './types.js';

/** A firing trigger's id plus the specific condition(s) that matched — the unit markers trace, so a
 *  post-mortem can see not just that a trigger fired but which rubric the classifier judged true and
 *  (if it said) why. */
interface FiredSource {
  id:      string;
  matched: FiredCondition[];
}

/** The outcome of the concurrent user-phase evaluation (see the racing note in {@link setupTriggers}):
 *  the rendered result bodies split by delivery — `ephemeral` (a `ephemeral`-kind fire, informs one
 *  answer) vs `durable` (a `contextual`-kind fire, folds onto the user turn and persists) — plus the
 *  firing sources and any markers (a silent side-effect's tool markers, or a trace). All empty ⇒
 *  nothing fired / nothing to do. */
interface UserPhaseOutcome {
  ephemeralBodies: string[];
  durableBodies:   string[];
  sources:         FiredSource[];
  markers:         MessageContent[];
}

/** A user-phase evaluation in flight for one turn, shared between the three places that may deliver its
 *  correction: the runner's in-situ restart (via the `DeferredScreen.claim()` the screen hook returns),
 *  an optional pre-first-token grace inject (screen, when `classifierGraceMs > 0`), and the post-commit
 *  `followup` retract. `ready`/`correction` let the runner poll synchronously; `claimed` is the
 *  exactly-once latch — whoever delivers sets it, so the other two see it and don't re-deliver. */
interface UserPhaseInFlight {
  verdict:    Promise<UserPhaseOutcome>;
  ready:      boolean;
  correction: DeferredCorrection;   // fenced ephemeral/durable blocks; both empty ⇒ no result-fire
  claimed:    boolean;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** The live trigger set (data-driven hooks). Registered by setupTriggers; consumed by plugins
     *  that seed built-in triggers (e.g. cognition). Its presence is the "triggers wired" signal. */
    Triggers?: Triggers;
  }
}

/** One-shot reachability probe for a pinned provider, used only when forming installationMessage
 *  (install/reload) — never on the hot path. Fails soft: a thrown error becomes `{ ok: false }`. */
async function testProvider(services: MatbotMachine, provider: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await services.singleTurn({ provider, prompt: 'Reply with "ok".', signal: AbortSignal.timeout(15000) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Multiple fired triggers' results are joined with a separator.
const JOIN = '\n\n---\n\n';

// Out-of-band tool output is delivered by folding it onto the user turn (user phase / agent retract)
// or as a robo turn (agent followup). Without a provenance marker the model reads it as the user
// speaking — observed in testing: the model's own thinking said "the user wants me to follow the
// skill…" about a system-injected directive. The dispatcher stays a dumb transport (it injects
// whatever a tool yields); this fence is the triggers plugin's own framing, marking the payload as
// system-supplied so the model treats it as context to act on, not a user utterance. A tool whose
// result is already a directive (e.g. `skill_action(use)`) self-frames *what* to do; the fence adds
// *who* supplied it — orthogonal, composes cleanly.
function fence(body: string): string {
  return `[Additional context — supplied by the system, not part of the user's message. ` +
    `Take it into account when responding.]\n\n${body}\n\n[End of additional context.]`;
}

// A durable trace that a user-phase result-fire caused a retract-redo. The redo's injected context is
// already recorded by the core retraction marker, but that marker doesn't know about triggers — this
// records WHICH user-phase trigger(s)/condition(s) drove the supersede, so a false-positive post-mortem
// can see why. A distinct `event` from the agent-phase `retract-fired` so the agent convergence guard
// (retractActiveLastTurn) never mistakes a user-phase source for one of its own retract rules.
function userRetractFiredMarker(triggers: FiredSource[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'user-retract-fired', surface: 'user', triggers } };
}

// A user-phase result-fire delivered on the CLEAN path — folded into the turn in-situ (the runner
// restarted a doomed generation) or before the first token (the screen grace inject) — rather than as a
// post-commit retract. No `matbot-retraction` marker exists in that case (nothing was popped), so this
// is the whole durable trace that the correction fired and via which trigger(s)/condition(s).
function userInsituFiredMarker(triggers: FiredSource[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'user-insitu-fired', surface: 'user', triggers } };
}

// Fence a user-phase outcome's result bodies into a delivery-ready correction: ephemeral bodies become a
// plain fenced block (tail-folded for one answer), durable bodies become a fenced `origin: 'robo'` block
// (folded onto the user turn, persisted + visible). Either side may be empty.
function fenceCorrection(out: UserPhaseOutcome): DeferredCorrection {
  return {
    ...(out.ephemeralBodies.length > 0 ? { ephemeral: [{ type: 'text', text: fence(out.ephemeralBodies.join(JOIN)) }] } : {}),
    ...(out.durableBodies.length   > 0 ? { durable:   [{ type: 'text', text: fence(out.durableBodies.join(JOIN)), origin: 'robo' as const }] } : {}),
  };
}
function hasCorrection(c: DeferredCorrection): boolean {
  return (c.ephemeral?.length ?? 0) > 0 || (c.durable?.length ?? 0) > 0;
}

// The core retraction marker's creator (core/src/session-runner.ts). Hardcoded as a
// documented cross-package string contract — markers are keyed by a creator string, and triggers
// depends only on plugin-api, not core. Keep in sync with RETRACTION_CREATOR there.
const RETRACTION_CREATOR = 'matbot-retraction';

// Suppression is NEVER silent: when a guard holds a trigger back, it leaves this marker naming the
// `cause` (a machine tag), a human `reason`, and the triggers (id + matched conditions) — so "why
// didn't it fire?" is answerable from the session months later rather than from a remembered heuristic.
// `retractFiredMarker` records which triggers/conditions caused a retract. Both are LLM-invisible
// diagnostics. The convergence guard reads back BOTH retract-fired AND its own `retract-convergence`
// suppressions (see retractActiveLastTurn).
type SuppressCause = 'user-redo' | 'retract-convergence' | 'followup-shadowed';
function suppressedMarker(cause: SuppressCause, reason: string, triggers: FiredSource[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'suppressed', cause, reason, triggers } };
}
function retractFiredMarker(triggers: FiredSource[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'retract-fired', triggers } };
}

// True when the latest turn is a retract-redo: a `matbot-retraction` marker sits after the last genuine
// (non-robo) user message — i.e. this user message was already processed on the original attempt, so
// user-phase (ephemeral/contextual) triggers and their side effects already fired. Re-firing them on the
// redo is the duplicate-side-effect bug; skip them.
function isRetractRedo(messages: Message[]): boolean {
  const lastUser = messages.findLastIndex(m => m.role === 'user' && !m.content.every(c => c.origin === 'robo'));
  if (lastUser < 0) return false;
  return messages.slice(lastUser + 1).some(m => m.content.some(c => c.type === 'marker' && c.creator === RETRACTION_CREATOR));
}

// Retract trigger ids that were ACTIVE on the PREVIOUS turn (the region between the second-to-last and
// last genuine user messages) — active meaning the rule either fired a retract OR was itself held off by
// the convergence guard. Counting suppressions too is what makes the guard *converge* rather than
// oscillate: a rule that keeps matching stays held off turn after turn (each suppression re-arms the
// guard), instead of firing every other turn because a suppressed turn left no trace. It un-sticks only
// when the rule genuinely stops matching for a turn (no marker), after which it may fire fresh. A
// well-behaved rule self-terminates and never lands here.
function retractActiveLastTurn(messages: Message[]): Set<string> {
  const userIdxs: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'user' && !m.content.every(c => c.origin === 'robo')) userIdxs.push(i); });
  const cur = userIdxs.at(-1);
  if (cur === undefined) return new Set();
  const prev = userIdxs.at(-2) ?? -1;
  const ids = new Set<string>();
  for (let i = prev + 1; i < cur; i++) {
    for (const c of messages[i]!.content) {
      if (c.type !== 'marker' || c.creator !== 'triggers') continue;
      const d = c.data as { event?: unknown; cause?: unknown; triggers?: unknown };
      const active = d?.event === 'retract-fired' || (d?.event === 'suppressed' && d?.cause === 'retract-convergence');
      if (active && Array.isArray(d.triggers)) {
        for (const t of d.triggers) {
          if (typeof t === 'object' && t !== null && typeof (t as { id?: unknown }).id === 'string') ids.add((t as { id: string }).id);
        }
      }
    }
  }
  return ids;
}

function textOf(msg: Message | undefined): string {
  return msg?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

/**
 * Wire the triggers subsystem: build the {@link TriggerManager}, load persisted triggers, register
 * the `Triggers` service and the `trigger_action` tool, then install the two evaluation hooks:
 *
 *   user  — a `screen` hook (pre-response) that KICKS OFF the `user`-phase classify+dispatch but does
 *           NOT await it: the classifier races the turn's own generation instead of gating the first
 *           token. Its verdict is consumed post-commit by the `followup` hook (below), so a user-phase
 *           result-fire supersedes the answer via a retract-redo rather than informing it in advance.
 *           This collapses the user surface toward the agent one — both are now concurrent-classify +
 *           post-turn-correct, differing only in subject (user message vs response). The `ephemeral`
 *           /`contextual` kinds no longer split delivery (a pre-response injection point is gone): any
 *           result-fire is delivered as a retract; a silent side-effect (no result) needs no delivery.
 *   agent — the `followup` hook (post-commit) also judges agent-surface conditions against the
 *           assistant's response, invokes each fired trigger's tool, and delivers the result per the
 *           fired condition's `kind`: `retract` (discard the response and re-run with the result
 *           injected) or `followup` (keep the response and resubmit the result as a robo turn). It
 *           merges the raced user-phase outcome into the same retract/resubmit decision.
 *
 * Both surfaces fence the injected payload (see {@link fence}) so the model reads it as system-supplied
 * context, not a user utterance.
 *
 * Returns the manager so a specialization (a node watcher, say) could attach to the same instance.
 * Uses only web-platform APIs.
 */
export async function setupTriggers(services: MatbotMachine): Promise<TriggerManager> {
  // Idempotent on the registered service, not a module flag (a re-import would reset a flag; the
  // registry persists for the process) — a second setupTriggers hands back the live manager.
  if (services.Triggers) return services.Triggers as TriggerManager;

  const store   = services.createStore<Trigger>('triggers') as Store<Trigger>;
  const manager = new TriggerManager(store, services);
  // No boot load and no StorageBackend-swap re-read: the manager reads straight through `store` (a
  // swap-following proxy) on every call, so it always reflects the live backend and current partition.
  await services.register('Triggers', manager);

  services.tools.register(createTriggerActionTool(manager));
  services.tools.register(createTriggersConfigTool(services));

  // In-flight user-phase evaluations, keyed by the turn's traceId. The `screen` hook kicks one off
  // (without awaiting) so the classifier races the turn's generation; the runner claims it in-situ via
  // the DeferredScreen, or the `followup` hook (same traceId) consumes-and-deletes it post-commit. An
  // entry exists only for a genuine, non-redo user turn. Keyed by traceId, so concurrent turns across
  // sessions never collide.
  const pendingUserPhase = new Map<string, UserPhaseInFlight>();

  // Optional pre-first-token grace: how long `screen` waits for the verdict before handing off to the
  // race. 0 (default) ⇒ pure race (the responsive path — no added latency, correction lands in-situ or
  // as a retract). A positive value trades that responsiveness back for cleanliness: a classifier that
  // settles within the window injects BEFORE the first token (the old "slow but clean" feel), a slower
  // one still races. Read live so a triggers_config/settings change takes effect next turn.
  const resolveGraceMs = async (): Promise<number> => {
    const v = await services.settings().get<number | string>('classifierGraceMs');
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  };

  // Judge the user message and dispatch every fired user-phase trigger, partitioning result bodies by
  // kind: `contextual` → durable (folded onto the user turn, persisted), everything else → ephemeral
  // (informs one answer). A silent fire contributes only its tool's markers. Runs off the turn's
  // critical path (kicked off in `screen`); the correction is delivered later on whichever path wins.
  const runUserPhase = async (ctx: { session: Session; signal: AbortSignal; provider: string; prompt?: PromptFn }): Promise<UserPhaseOutcome> => {
    const lastUser = ctx.session.messages.findLast(l => l.role === 'user');
    const fired = await manager.evaluate(
      'user',
      { label: 'latest user message', text: textOf(lastUser) },
      { label: 'preceding assistant message', text: textOf(ctx.session.messages.findLast(
        l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
      )) },
      ctx.signal,
      ctx.provider,
    );
    const ephemeralBodies: string[]         = [];
    const durableBodies:   string[]         = [];
    const sources:         FiredSource[]    = [];
    const markers:         MessageContent[] = [];
    for (const { trigger, kinds, matched } of fired) {
      const out = await dispatchTrigger(services, trigger, { session: ctx.session, signal: ctx.signal, provider: ctx.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
      if (out.hadResult) {
        // Contextual dominates: a trigger carrying both kinds folds durable (a superset of ephemeral —
        // it persists AND informs this answer), mirroring the agent surface's retract-over-followup.
        if (kinds.includes('contextual')) durableBodies.push(renderResult(out.result));
        else                              ephemeralBodies.push(renderResult(out.result));
        sources.push({ id: trigger.id, matched });
      }
      markers.push(...out.markers);
    }
    return { ephemeralBodies, durableBodies, sources, markers };
  };

  // user phase — kicked off pre-response, NOT awaited. Judging the user message concurrently with the
  // turn keeps the classifier off the pre-first-token critical path. The correction is delivered by
  // whichever of three points wins: the runner's in-situ restart (via the returned DeferredScreen), a
  // pre-first-token grace inject (when `classifierGraceMs > 0`), or the post-commit `followup` retract.
  services.hooks.register({
    on: 'screen',
    async handler(ctx) {
      const lastUser = ctx.session.messages.findLast(l => l.role === 'user');
      // Skip our own agent-phase robo resubmissions — they are not real user turns.
      if (!lastUser || lastUser.content.every(c => c.origin === 'robo')) return;

      // Guard: a retract-redo re-runs this same user turn. The user-phase triggers already fired — and
      // their side effects (e.g. remember_fact's store write) already happened — on the original
      // attempt, so re-firing would double-apply them. Don't kick a second evaluation off; the redo
      // already carries the retract correction as injected context. Record why (never silent).
      if (isRetractRedo(ctx.session.messages)) {
        return { markers: [suppressedMarker('user-redo', 'user-phase triggers held off: retract-redo (user message already processed on the original attempt)', [])] };
      }

      // No traceId ⇒ can't correlate to the followup hook that consumes the verdict; skip racing (a
      // direct runSession caller without a traceId simply gets no user-phase triggers). In the pump —
      // the only real entry point — traceId is always set.
      const traceId = ctx.config.traceId;
      if (traceId === undefined) return;

      // Kick off classify+dispatch; do not await. The record's `ready`/`fenced` let the runner poll
      // synchronously; `.catch` neutralises an aborted-turn rejection (the classifier shares the turn's
      // signal) so it never surfaces as an unhandled rejection.
      const rec: UserPhaseInFlight = { verdict: undefined as unknown as Promise<UserPhaseOutcome>, ready: false, correction: {}, claimed: false };
      rec.verdict = runUserPhase({ session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) })
        .then(out => { rec.ready = true; rec.correction = fenceCorrection(out); return out; })
        .catch((): UserPhaseOutcome => { rec.ready = true; return { ephemeralBodies: [], durableBodies: [], sources: [], markers: [] }; });
      pendingUserPhase.set(traceId, rec);

      // Optional grace: wait up to `classifierGraceMs` for the verdict before racing. If it lands with a
      // result-fire, deliver it as ordinary ephemeral (injected before the first token — the clean path)
      // and latch `claimed` so neither the runner nor followup re-delivers it. At 0 (default) this is
      // skipped entirely — pure race, no added latency.
      const graceMs = await resolveGraceMs();
      if (graceMs > 0) {
        await Promise.race([rec.verdict, new Promise(r => setTimeout(r, graceMs))]);
        if (rec.ready && hasCorrection(rec.correction) && !rec.claimed) {
          rec.claimed = true;
          return {
            ...(rec.correction.ephemeral ? { ephemeral: rec.correction.ephemeral } : {}),
            ...(rec.correction.durable   ? { durable:   rec.correction.durable   } : {}),
          };
        }
      }

      // Race path: hand the runner a deferred that claims the correction exactly once for an in-situ
      // restart (or a pre-generation fold). Not settled / no result / already claimed ⇒ undefined.
      return {
        deferred: {
          claim: (): DeferredCorrection | undefined => {
            if (!rec.ready || rec.claimed || !hasCorrection(rec.correction)) return undefined;
            rec.claimed = true;
            return rec.correction;
          },
        },
      };
    },
  });

  // agent phase — post-commit. Judges the assistant's response (with the preceding user message as
  // relational context), invokes fired triggers, and delivers each one per its condition's `kind`:
  //   retract  — the response was WRONG: pop it and re-run the user turn with the output injected.
  //   followup — the response STANDS but needs a steer: keep it, resubmit a robo turn carrying the
  //              output (so the response remains in context for the steer to make sense).
  // Skips our own redos/resubmits (resubmitDepth > 0) so a fired trigger can't re-fire on its output.
  services.hooks.register({
    on: 'followup',
    async handler(ctx) {
      // Consume the raced user-phase record kicked off in `screen` (present only for a genuine, non-redo
      // user turn). Delete-on-read keeps the map bounded; an aborted turn (followup skipped entirely)
      // leaves at most one orphan whose promise already .catch'd itself into a harmless value.
      const traceId = ctx.config.traceId;
      const rec     = traceId !== undefined ? pendingUserPhase.get(traceId) : undefined;
      if (traceId !== undefined) pendingUserPhase.delete(traceId);

      if (ctx.resubmitDepth > 0) return;

      const userOut: UserPhaseOutcome = rec ? await rec.verdict : { ephemeralBodies: [], durableBodies: [], sources: [], markers: [] };
      // `claimed` ⇒ the correction was already delivered on the clean path (the runner's in-situ restart
      // or the screen grace inject), so it must NOT also enter the retract context below.
      const insitu = rec?.claimed ?? false;

      const fired = await manager.evaluate(
        'agent',
        { label: 'assistant response', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        { label: 'preceding user message', text: textOf(ctx.session.messages.findLast(l => l.role === 'user')) },
        ctx.signal,
        ctx.config.provider,
      );

      // Convergence guard: a retract rule that already retracted on the PREVIOUS turn and is about to
      // again has not converged (the redo didn't dissolve its condition). Hold those rules off so a
      // mis-tuned retract can't pop-and-redo every turn forever. A well-behaved rule self-terminates
      // (its redo cures the defect, so it won't fire next turn) and never lands here. (User-phase fires
      // need no such guard: `screen` skips them on a redo, so they fire at most once per user message.)
      const heldOff = retractActiveLastTurn(ctx.session.messages);

      // Partition agent fired triggers' output by their kind. A trigger can carry both retract and
      // followup conditions; if any retract condition fired, the trigger is treated as retract (a wrong
      // answer can't be merely steered). Markers are collected regardless — they persist whichever path
      // runs. The raced user-phase markers ride alongside from the start.
      const retractBodies:   string[]         = [];
      const retractSources:  FiredSource[]    = [];
      const followupBodies:  string[]         = [];
      const followupSources: FiredSource[]    = [];
      const suppressed:      FiredSource[]    = [];
      const markers:         MessageContent[] = [...userOut.markers];
      for (const { trigger, kinds, matched } of fired) {
        if (kinds.includes('retract') && heldOff.has(trigger.id)) {
          suppressed.push({ id: trigger.id, matched: matched.filter(m => m.kind === 'retract') });
          continue;
        }
        const out = await dispatchTrigger(services, trigger, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) {
          if (kinds.includes('retract')) {
            retractBodies.push(renderResult(out.result));
            retractSources.push({ id: trigger.id, matched: matched.filter(m => m.kind === 'retract') });
          } else {
            followupBodies.push(renderResult(out.result));
            followupSources.push({ id: trigger.id, matched: matched.filter(m => m.kind === 'followup') });
          }
        }
        markers.push(...out.markers);
      }
      // Suppression is never silent — record which rules were held off and why.
      if (suppressed.length > 0) {
        markers.push(suppressedMarker('retract-convergence', 'retract held off: this rule was active on the previous turn and is still matching (non-converging)', suppressed));
      }

      // A user-phase result-fire already delivered on the clean path (in-situ / grace) is traced but does
      // NOT re-enter the turn — it's already there. Only an UNclaimed one lands here, meaning the verdict
      // arrived after commit: it supersedes the answer via retract. Its ephemeral bodies lead the context
      // (they address the QUESTION; an agent retract addresses the ANSWER); its durable bodies (a
      // contextual fire) fold onto the re-run's user message so the correction persists, not just informs.
      const userHadFire = userOut.ephemeralBodies.length > 0 || userOut.durableBodies.length > 0;
      if (insitu && userHadFire) markers.push(userInsituFiredMarker(userOut.sources));
      const userEph = insitu ? [] : userOut.ephemeralBodies;
      const userDur = insitu ? [] : userOut.durableBodies;
      const retractContext = [...userEph, ...retractBodies];
      const retractDurable = userDur;

      // Retract dominates: if ANY trigger (user- or agent-phase) judged the exchange wrong, the response
      // is discarded, so a steer that critiques it has lost its subject — skip the followup bodies this
      // turn. That skip is a suppression too, so it leaves a `suppressed` marker (answerable from the
      // session). The redo's injected context is recorded by the core retraction marker; the phase-tagged
      // `retract-fired` markers let a post-mortem (and, for agent, the next turn's convergence guard)
      // see which side fired.
      if (retractContext.length > 0 || retractDurable.length > 0) {
        if (followupBodies.length > 0) {
          markers.push(suppressedMarker('followup-shadowed', 'followup steer skipped: a retract on the same turn supersedes the response it would critique', followupSources));
        }
        if (userEph.length > 0 || userDur.length > 0) markers.push(userRetractFiredMarker(userOut.sources));
        if (retractBodies.length > 0)                 markers.push(retractFiredMarker(retractSources));
        return {
          retractAndRerun: {
            ...(retractContext.length > 0 ? { context: [{ type: 'text', text: fence(retractContext.join(JOIN)) }] } : {}),
            ...(retractDurable.length > 0 ? { durable: [{ type: 'text', text: fence(retractDurable.join(JOIN)), origin: 'robo' as const }] } : {}),
          },
          markers,
        };
      }
      if (followupBodies.length > 0) {
        return {
          resubmit: { content: [{ type: 'text', origin: 'robo', text: fence(followupBodies.join(JOIN)) }] },
          ...(markers.length > 0 ? { markers } : {}),
        };
      }
      // No model-facing result from any trigger — only markers (silent side-effects), if any.
      return markers.length > 0 ? { markers } : undefined;
    },
  });

  return manager;
}

/**
 * The cross-runtime triggers plugin: stored conditions that, when an LLM classifier judges them
 * matched, invoke a tool. CRUD via `trigger_action`; the `agent`/`user` conditions are evaluated by a
 * classifier provider (pinned via `triggers_config`, else the turn's own provider). Runs in both Node
 * and the browser.
 */
export function createTriggersPlugin(): MatbotPluginSpec {
  let manager:  TriggerManager  | undefined;
  let captured: MatbotMachine  | undefined;   // captured in setup() so installationMessage() can probe

  const base =
    'Triggers are active (trigger_action). A trigger fires a tool when an LLM classifier judges one of ' +
    'its conditions matched against the current turn.';

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Data-driven hooks: stored conditions that invoke a tool when an LLM classifier judges them matched. CRUD via trigger_action. Cross-runtime (node + browser).',
    },

    async installationMessage() {
      if (!captured) return base;
      const pinned    = await captured.settings().get<string>('classifierProvider');
      const available = [...captured.providers.keys()];
      const legacy    = captured.providers.has('skills-classifier');
      if (pinned === undefined) {
        return base +
          (legacy
            ? '\n\nThe classifier uses the provider "skills-classifier" (the legacy default present in this install).'
            : '\n\nNo classifier provider is pinned, so the classifier uses whatever provider the current turn ' +
              'runs on — triggers work out of the box.') +
          ' To pin a small/fast model instead, use the triggers_config tool (action "set"). ' +
          `Available providers: ${available.join(', ') || '(none)'}.`;
      }
      const probe = await testProvider(captured, pinned);
      return base +
        `\n\nThe classifier is pinned to "${pinned}" (triggers_config), which ` +
        (probe.ok
          ? 'responded to a test prompt.'
          : `did NOT respond: ${probe.error}. It falls back to the turn's own provider until fixed.`);
    },

    async setup(services) {
      captured = services;
      manager  = await setupTriggers(services);
    },

    async teardown() {
      manager?.clear();
    },
  };
}

export const plugin: MatbotPluginSpec = createTriggersPlugin();
