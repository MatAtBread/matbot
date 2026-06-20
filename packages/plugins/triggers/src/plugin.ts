import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices, Store, Message, MessageContent } from '@matatbread/matbot-plugin-api';
import { TriggerManager } from './manager.js';
import { dispatchTrigger, renderResult } from './dispatch.js';
import { createTriggerActionTool } from './tools.js';
import type { Trigger, Triggers } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** The live trigger set (data-driven hooks). Registered by setupTriggers; consumed by plugins
     *  that seed built-in triggers (e.g. cognition). Its presence is the "triggers wired" signal. */
    Triggers?: Triggers;
  }
}

// The provider name is retained from the skills implementation this was extracted from, so existing
// `matbot.yaml` configs keep working without a rename. It points at a small, fast model.
const CLASSIFIER_PROVIDER = 'skills-classifier';

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

// A durable trace of an augment-phase ephemeral injection (screen-ephemeral) — never otherwise
// persisted, so without this a post-mortem can't see what the system fed the model before it answered.
// LLM-invisible like any marker; a frontend may ignore it (diagnostic, not user-facing). `text` is the
// raw joined body (pre-fence); `triggers` are the firing trigger ids. (The other ephemeral injection —
// a retract redo's context — is traced by the core retraction marker, not here; a `followup` resubmit
// is a persisted robo turn and needs no trace.)
function injectionMarker(triggers: string[], text: string): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'ephemeral-inject', surface: 'user', triggers, text } };
}

// The core retraction marker's creator (packages/core/runner/src/session-runner.ts). Hardcoded as a
// documented cross-package string contract — markers are keyed by a creator string, and triggers
// depends only on plugin-api, not core. Keep in sync with RETRACTION_CREATOR there.
const RETRACTION_CREATOR = 'matbot-retraction';

// Suppression is NEVER silent: when a guard holds a trigger back, it leaves this marker naming the
// `cause` (a machine tag), a human `reason`, and the triggers — so "why didn't it fire?" is answerable
// from the session months later rather than from a remembered heuristic. `retractFiredMarker` records
// which triggers caused a retract. Both are LLM-invisible diagnostics. The convergence guard reads back
// BOTH retract-fired AND its own `retract-convergence` suppressions (see retractActiveLastTurn).
type SuppressCause = 'augment-redo' | 'retract-convergence' | 'followup-shadowed';
function suppressedMarker(cause: SuppressCause, reason: string, triggers: string[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'suppressed', cause, reason, triggers } };
}
function retractFiredMarker(triggers: string[]): MessageContent {
  return { type: 'marker', creator: 'triggers', data: { event: 'retract-fired', triggers } };
}

// True when the latest turn is a retract-redo: a `matbot-retraction` marker sits after the last genuine
// (non-robo) user message — i.e. this user message was already processed on the original attempt, so
// user-phase (augment) triggers and their side effects already fired. Re-firing them on the redo is the
// duplicate-side-effect bug; skip them.
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
        for (const id of d.triggers) if (typeof id === 'string') ids.add(id);
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
 *           message, invokes each fired trigger's tool, and injects the results EPHEMERALLY (this
 *           turn only, never persisted).
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
export async function setupTriggers(services: MatbotServices): Promise<TriggerManager> {
  // Idempotent on the registered service, not a module flag (a re-import would reset a flag; the
  // registry persists for the process) — a second setupTriggers hands back the live manager.
  if (services.Triggers) return services.Triggers as TriggerManager;

  const store   = services.createStore<Trigger>('triggers') as Store<Trigger>;
  const manager = new TriggerManager(store, services, CLASSIFIER_PROVIDER);
  await manager.init();
  await services.register('Triggers', manager);

  services.tools.register(createTriggerActionTool(manager));

  // user phase — pre-response. Judges the incoming user message; injects fired triggers' tool
  // results ephemerally so they inform this response without persisting.
  services.hooks.register({
    on: 'screen',
    async handler(ctx) {
      if (!services.providers.has(CLASSIFIER_PROVIDER)) return;
      const lastUser = ctx.session.messages.findLast(l => l.role === 'user');
      // Skip our own agent-phase robo resubmissions — they are not real user turns.
      if (!lastUser || lastUser.content.every(c => c.origin === 'robo')) return;

      // Guard: a retract-redo re-runs this same user turn. The user-phase (augment) triggers already
      // fired — and their side effects (e.g. remember_fact's store write) already happened — on the
      // original attempt, so re-firing here double-applies them. Hold off, and record why (suppression
      // is never silent). The redo still gets the retract correction via the injected context.
      if (isRetractRedo(ctx.session.messages)) {
        return { markers: [suppressedMarker('augment-redo', 'augment held off: retract-redo (user message already processed on the original attempt)', [])] };
      }

      const fired = await manager.evaluate(
        'user',
        { label: 'latest user message', text: textOf(lastUser) },
        { label: 'preceding assistant message', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        ctx.signal,
      );
      if (fired.length === 0) return;

      const bodies:  string[]         = [];
      const sources: string[]         = [];
      const markers: MessageContent[] = [];
      for (const { trigger } of fired) {
        const out = await dispatchTrigger(services, trigger, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) { bodies.push(renderResult(out.result)); sources.push(trigger.id); }
        markers.push(...out.markers);
      }
      // Trace the ephemeral injection durably (the injected text itself is never persisted).
      if (bodies.length > 0) markers.push(injectionMarker(sources, bodies.join(JOIN)));
      if (bodies.length === 0 && markers.length === 0) return;

      return {
        // The dispatcher appends these to the session AND emits them live (consistent draw/reload).
        ...(markers.length > 0 ? { markers } : {}),
        ...(bodies.length  > 0 ? { ephemeral: [{ type: 'text', text: fence(bodies.join(JOIN)) }] } : {}),
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
      if (!services.providers.has(CLASSIFIER_PROVIDER)) return;

      const fired = await manager.evaluate(
        'agent',
        { label: 'assistant response', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        { label: 'preceding user message', text: textOf(ctx.session.messages.findLast(l => l.role === 'user')) },
        ctx.signal,
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
      const retractSources:  string[]         = [];
      const followupBodies:  string[]         = [];
      const followupSources: string[]         = [];
      const suppressed:      string[]         = [];
      const markers:         MessageContent[] = [];
      for (const { trigger, kinds } of fired) {
        if (kinds.includes('retract') && heldOff.has(trigger.id)) { suppressed.push(trigger.id); continue; }
        const out = await dispatchTrigger(services, trigger, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) {
          if (kinds.includes('retract')) { retractBodies.push(renderResult(out.result));  retractSources.push(trigger.id); }
          else                           { followupBodies.push(renderResult(out.result)); followupSources.push(trigger.id); }
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
 * matched, invoke a tool. CRUD via `trigger_action`; the `agent`/`user` conditions are evaluated by
 * a classifier provider named "skills-classifier". Runs in both Node and the browser.
 */
export function createTriggersPlugin(): MatbotPluginSpec {
  let manager: TriggerManager | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Data-driven hooks: stored conditions that invoke a tool when an LLM classifier judges them matched. CRUD via trigger_action. Cross-runtime (node + browser).',
    },

    async installationMessage() {
      return 'Triggers are active (trigger_action). A trigger fires a tool when an LLM classifier ' +
        'judges one of its conditions matched against the current turn; the classifier needs a ' +
        'provider named "skills-classifier" — until one is configured, triggers simply never fire. ' +
        'Add it with the `provider` tool, pointing it at a small, fast model. Offer to do this now.';
    },

    async setup(services) {
      manager = await setupTriggers(services);
    },

    async teardown() {
      manager?.clear();
    },
  };
}

export const plugin: MatbotPluginSpec = createTriggersPlugin();
