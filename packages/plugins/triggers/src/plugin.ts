import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, Store, Message, MessageContent } from '@matatbread/matbot-plugin-api';
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

// A durable trace of a user-phase injection. For `ephemeral-inject` the injected `text` is never
// otherwise persisted, so without this a post-mortem can't see what the system fed the model before it
// answered; for `durable-inject` the text IS persisted (folded onto the user turn), so `text` is
// omitted and the marker records only WHICH condition fired and why. LLM-invisible like any marker; a
// frontend may ignore it (diagnostic, not user-facing). `triggers` are the firing sources (id +
// matched conditions). (The agent-phase injections are traced elsewhere: a retract redo's context by
// the core retraction marker, and a `followup` resubmit by its persisted robo turn.)
function injectionMarker(event: 'ephemeral-inject' | 'durable-inject', triggers: FiredSource[], text?: string): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event, surface: 'user', triggers, ...(text !== undefined ? { text } : {}) } };
}

// The core retraction marker's creator (packages/core/runner/src/session-runner.ts). Hardcoded as a
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
 *   user  — a `screen` hook (pre-response) that judges `user`-phase conditions against the incoming
 *           message, invokes each fired trigger's tool, and delivers the result per the fired
 *           condition's `kind`: `ephemeral` (inject for this turn only, never persisted) or
 *           `contextual` (fold DURABLY onto the user message — persisted + visible — so it updates
 *           the conversation rather than informing one answer).
 *   agent — a `followup` hook (post-commit) that judges agent-surface conditions against the
 *           assistant's response, invokes each fired trigger's tool, and delivers the result per the
 *           fired condition's `kind`: `retract` (discard the response and re-run with the result
 *           injected) or `followup` (keep the response and resubmit the result as a robo turn).
 *
 * Both phases fence the injected payload (see {@link fence}) so the model reads it as system-supplied
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
  await manager.load();
  // Re-read after a deferred StorageBackend swap lands: the new backend's `triggers` namespace replaces
  // the old in-memory set. `mounted` fires only on a real swap, so this never doubles the boot load
  // above. Ends with the manager (teardown aborts manager.signal).
  services.mounted.consume(() => void manager.load(), manager.signal);
  await services.register('Triggers', manager);

  services.tools.register(createTriggerActionTool(manager));
  services.tools.register(createTriggersConfigTool(services));

  // user phase — pre-response. Judges the incoming user message and delivers each fired trigger's tool
  // result by its kind: `ephemeral` informs this response only; `contextual` folds durably onto the
  // user turn so it persists into the conversation.
  services.hooks.register({
    on: 'screen',
    async handler(ctx) {
      const lastUser = ctx.session.messages.findLast(l => l.role === 'user');
      // Skip our own agent-phase robo resubmissions — they are not real user turns.
      if (!lastUser || lastUser.content.every(c => c.origin === 'robo')) return;

      // Guard: a retract-redo re-runs this same user turn. The user-phase (ephemeral/contextual)
      // triggers already fired — and their side effects (e.g. remember_fact's store write, or a
      // contextual fold persisted onto the user message) already happened — on the original attempt,
      // so re-firing here double-applies them. Hold off, and record why (suppression is never silent).
      // The redo still gets the retract correction via the injected context.
      if (isRetractRedo(ctx.session.messages)) {
        return { markers: [suppressedMarker('user-redo', 'user-phase triggers held off: retract-redo (user message already processed on the original attempt)', [])] };
      }

      const fired = await manager.evaluate(
        'user',
        { label: 'latest user message', text: textOf(lastUser) },
        { label: 'preceding assistant message', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        ctx.signal,
        ctx.config.provider,
      );
      if (fired.length === 0) return;

      // Partition fired triggers' output by delivery. A trigger can carry both kinds on this surface;
      // if any `contextual` condition fired the output goes durable, since a durable fold is also sent
      // on this very turn (it lands in the user message before the provider call) — it is a superset of
      // ephemeral, so "contextual dominates" loses nothing, mirroring retract-over-followup on the
      // agent surface. Markers are collected regardless — they persist whichever path runs.
      const ephemeralBodies:  string[]         = [];
      const ephemeralSources: FiredSource[]    = [];
      const durableBodies:    string[]         = [];
      const durableSources:   FiredSource[]    = [];
      const markers:          MessageContent[] = [];
      for (const { trigger, kinds, matched } of fired) {
        const out = await dispatchTrigger(services, trigger, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) {
          if (kinds.includes('contextual')) {
            durableBodies.push(renderResult(out.result));
            durableSources.push({ id: trigger.id, matched: matched.filter(m => m.kind === 'contextual') });
          } else {
            ephemeralBodies.push(renderResult(out.result));
            ephemeralSources.push({ id: trigger.id, matched: matched.filter(m => m.kind === 'ephemeral') });
          }
        }
        markers.push(...out.markers);
      }
      // Trace each injection. The ephemeral text is never otherwise persisted, so the marker carries it;
      // the durable text rides the user message itself, so its marker records only the firing sources.
      if (ephemeralBodies.length > 0) markers.push(injectionMarker('ephemeral-inject', ephemeralSources, ephemeralBodies.join(JOIN)));
      if (durableBodies.length   > 0) markers.push(injectionMarker('durable-inject',   durableSources));
      if (ephemeralBodies.length === 0 && durableBodies.length === 0 && markers.length === 0) return;

      return {
        // The dispatcher appends markers to the session AND emits them live (consistent draw/reload).
        // `ephemeral` informs only this turn; `durable` folds onto the user turn (origin: 'robo'),
        // persists, and is carried live as a robo-user event.
        ...(markers.length         > 0 ? { markers } : {}),
        ...(ephemeralBodies.length > 0 ? { ephemeral: [{ type: 'text', text: fence(ephemeralBodies.join(JOIN)) }] } : {}),
        ...(durableBodies.length   > 0 ? { durable:   [{ type: 'text', text: fence(durableBodies.join(JOIN)), origin: 'robo' as const }] } : {}),
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
      if (ctx.resubmitDepth > 0) return;

      const fired = await manager.evaluate(
        'agent',
        { label: 'assistant response', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        { label: 'preceding user message', text: textOf(ctx.session.messages.findLast(l => l.role === 'user')) },
        ctx.signal,
        ctx.config.provider,
      );
      if (fired.length === 0) return;

      // Convergence guard: a retract rule that already retracted on the PREVIOUS turn and is about to
      // again has not converged (the redo didn't dissolve its condition). Hold those rules off so a
      // mis-tuned retract can't pop-and-redo every turn forever. A well-behaved rule self-terminates
      // (its redo cures the defect, so it won't fire next turn) and never lands here.
      const heldOff = retractActiveLastTurn(ctx.session.messages);

      // Partition fired triggers' output by their kind. A trigger can carry both retract and followup
      // conditions; if any retract condition fired, the trigger is treated as retract (a wrong answer
      // can't be merely steered). Markers are collected regardless — they persist whichever path runs.
      const retractBodies:   string[]         = [];
      const retractSources:  FiredSource[]    = [];
      const followupBodies:  string[]         = [];
      const followupSources: FiredSource[]    = [];
      const suppressed:      FiredSource[]    = [];
      const markers:         MessageContent[] = [];
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

      // Retract dominates: if any trigger judged the response WRONG, the response is discarded, so a
      // steer that critiques it has lost its subject — skip the followup bodies this turn. That skip is
      // a suppression too, so it leaves a `suppressed` marker (not just a log): a followup that "didn't
      // fire" because a retract preempted it is answerable from the session. The redo's injected context
      // is recorded by the core retraction marker; the `retract-fired` marker lets the next turn's
      // convergence guard see this firing.
      if (retractBodies.length > 0) {
        if (followupBodies.length > 0) {
          markers.push(suppressedMarker('followup-shadowed', 'followup steer skipped: a retract on the same turn supersedes the response it would critique', followupSources));
        }
        markers.push(retractFiredMarker(retractSources));
        return {
          retractAndRerun: { context: [{ type: 'text', text: fence(retractBodies.join(JOIN)) }] },
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
