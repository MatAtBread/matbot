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

// No framing here: the dispatcher is a transport. A tool that wants its result acted on frames it
// itself (e.g. `skill_action(use)` returns content already wrapped as "follow these instructions").
// Multiple fired triggers' results are joined with a separator.
const JOIN = '\n\n---\n\n';

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
 *   agent — a `followup` hook (post-commit) that judges `agent`-phase conditions against the
 *           assistant's response, invokes each fired trigger's tool, and resubmits the results as a
 *           robo turn.
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
      const markers: MessageContent[] = [];
      for (const t of fired) {
        const out = await dispatchTrigger(services, t, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) bodies.push(renderResult(out.result));
        markers.push(...out.markers);
      }
      console.warn(`[triggers] screen: fired=${fired.length} bodies=${bodies.length} markers=${markers.length} -> ${bodies.length > 0 ? 'inject ephemeral' : 'no ephemeral'}`);
      if (bodies.length === 0 && markers.length === 0) return;

      return {
        // The dispatcher appends these to the session AND emits them live (consistent draw/reload).
        ...(markers.length > 0 ? { markers } : {}),
        ...(bodies.length  > 0 ? { ephemeral: [{ type: 'text', text: bodies.join(JOIN) }] } : {}),
      };
    },
  });

  // agent phase — post-commit. Judges the assistant's response (with the preceding user message as
  // relational context), invokes fired triggers, and resubmits the results as a robo turn. Skips
  // our own resubmissions (resubmitDepth > 0) so a fired trigger can't re-fire on its own output.
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
      console.warn(`[triggers] followup: agent-phase evaluated, fired=${fired.length}`);
      if (fired.length === 0) return;

      const bodies:  string[]         = [];
      const markers: MessageContent[] = [];
      for (const t of fired) {
        const out = await dispatchTrigger(services, t, { session: ctx.session, signal: ctx.signal, provider: ctx.config.provider, ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}) });
        if (out.hadResult) bodies.push(renderResult(out.result));
        markers.push(...out.markers);
      }
      if (bodies.length === 0 && markers.length === 0) return;

      return {
        ...(bodies.length  > 0 ? { resubmit: { content: [{ type: 'text', origin: 'robo', text: bodies.join(JOIN) }] } } : {}),
        // Markers append durably to the committed session via the pump (the followup durable-write point).
        ...(markers.length > 0 ? { markers } : {}),
      };
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
