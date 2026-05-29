import type {
  Hook, HookContext, Message, FormField,
  PluginSettings, CompletionRequest, CompletionResponse,
} from '@matatbread/matbot-plugin-api';
import type { SkillEntry } from './types.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function lastAssistantText(session: HookContext['session']): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg?.role !== 'assistant') continue;
    return msg.content
      .filter((c): c is Extract<Message['content'][number], { type: 'text' }> => c.type === 'text')
      .map(c => c.text)
      .join('');
  }
  return '';
}

function contextsOverlap(a: string[], b: string[]): boolean {
  return a.some(c => b.includes(c));
}

function makeSystemMsg(text: string): Message {
  return {
    id:        crypto.randomUUID(),
    role:      'system',
    content:   [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    traceId:   '',
  };
}

function makeFormMessage(providerNames: string[]): Message {
  const field: FormField = {
    name:     'provider',
    label:    'Select the LLM to use for skill classification',
    type:     'select',
    options:  providerNames,
    required: true,
  };
  return {
    id:        crypto.randomUUID(),
    role:      'assistant',
    content:   [{ type: 'form', fields: [field], submitLabel: 'Set classifier' }],
    createdAt: new Date().toISOString(),
    traceId:   '',
  };
}

function stripFormTail(messages: readonly Message[]): Message[] {
  let end = messages.length;
  while (end > 0) {
    const msg = messages[end - 1];
    if (msg?.content.some(c => c.type === 'form' || c.type === 'form-response')) {
      end--;
    } else {
      break;
    }
  }
  return messages.slice(0, end);
}

// ── createSkillIndexHook ──────────────────────────────────────────────────────

/**
 * before:submit — injects a skill index (names only) so the LLM knows
 * what skills are available and can call `skill:load` for any it needs.
 */
export function createSkillIndexHook(
  getSkills: () => SkillEntry[],
  priority   = 30,
): Hook {
  return {
    point: 'before:submit',
    priority,
    async handler(ctx: HookContext): Promise<HookContext> {
      const skills = getSkills().filter(
        s => contextsOverlap(s.contexts, ctx.session.contexts.length > 0 ? ctx.session.contexts : ['global']),
      );
      if (skills.length === 0) return ctx;

      const list = skills.map(s => `- ${s.name}`).join('\n');
      const text = `Available skills (use the \`skill_load\` tool to read the full content of any skill):\n${list}`;

      const session = {
        ...ctx.session,
        messages: [makeSystemMsg(text), ...ctx.session.messages],
      };
      return { ...ctx, session };
    },
  };
}

// ── createClassifierSetupHook ─────────────────────────────────────────────────

/**
 * before:submit — on the first user turn, if no classifier provider is
 * configured, interrupts the submission and surfaces a selection form.
 * When the user responds, stores the chosen provider and re-injects the
 * original message so the turn proceeds normally.
 *
 * Uses ctx.abort + a form message rather than a confirmable input parameter
 * so the flow cannot be bypassed by a prompt injection passing a pre-chosen value.
 */
export function createClassifierSetupHook(
  settings:  PluginSettings,
  providers: ReadonlyMap<string, unknown>,
  getSkills: () => SkillEntry[],
  priority   = 5,
): Hook {
  // In-memory park: one pending message per session while the form is shown.
  const parked = new Map<string, Message>();

  return {
    point: 'before:submit',
    priority,
    async handler(ctx: HookContext): Promise<HookContext | void> {
      if (getSkills().length === 0) return;
      if (await settings.get<string>('classifier')) return;

      const messages = ctx.session.messages;
      const lastMsg  = messages.at(-1);

      // Did the user just submit the selection form?
      if (lastMsg?.role === 'user') {
        const formResp = lastMsg.content.find(
          (c): c is Extract<Message['content'][number], { type: 'form-response' }> =>
            c.type === 'form-response',
        );
        if (formResp) {
          const selected = formResp.values['provider'];
          if (selected !== undefined && providers.has(selected)) {
            await settings.set('classifier', selected);
            const clean    = stripFormTail(messages);
            const original = parked.get(ctx.session.id);
            parked.delete(ctx.session.id);
            const session = {
              ...ctx.session,
              messages: original ? [...clean, original] : clean,
            };
            return {
              ...ctx,
              session,
              ...(original ? { inject: original.content } : {}),
            };
          }
          // Invalid selection — fall through to re-show the form.
        }
      }

      // No classifier yet: park the triggering message and show the selection form.
      if (lastMsg?.role === 'user') parked.set(ctx.session.id, lastMsg);

      const session = {
        ...ctx.session,
        messages: [
          ...(lastMsg?.role === 'user' ? messages.slice(0, -1) : messages),
          makeFormMessage([...providers.keys()]),
        ],
      };
      return { ...ctx, session, abort: 'classifier-setup' };
    },
  };
}

// ── createSkillClassifierHook ─────────────────────────────────────────────────

/**
 * after:response — calls the configured classifier LLM to decide whether the
 * assistant's response indicates it needs additional skill context, then
 * injects relevant skill content for the next LLM call if so.
 */
export function createSkillClassifierHook(
  getSkills:   () => SkillEntry[],
  readContent: (entry: SkillEntry) => Promise<string>,
  settings:    PluginSettings,
  complete:    (req: CompletionRequest) => Promise<CompletionResponse>,
  priority     = 30,
): Hook {
  return {
    point: 'after:response',
    priority,
    async handler(ctx: HookContext): Promise<HookContext | void> {
      const classifierProvider = await settings.get<string>('classifier');
      if (!classifierProvider) return;

      const responseText = lastAssistantText(ctx.session);
      if (!responseText) return;

      const { text: verdict } = await complete({
        provider:   classifierProvider,
        system:     'You are a classifier. Respond with only "yes" or "no".',
        messages:   [{
          id:        crypto.randomUUID(),
          role:      'user',
          content:   [{ type: 'text', text: `Does this response indicate the assistant needs more context or skills to answer fully?\n\n${responseText}` }],
          createdAt: new Date().toISOString(),
          traceId:   '',
        }],
        parameters: { maxTokens: 5, temperature: 0 },
        signal:     ctx.signal,
      });

      if (!verdict.trim().toLowerCase().startsWith('yes')) return;

      const sessionContexts = ctx.session.contexts.length > 0 ? ctx.session.contexts : ['global'];
      const relevant = getSkills().filter(s => contextsOverlap(s.contexts, sessionContexts));
      if (relevant.length === 0) return;

      const blocks = await Promise.all(
        relevant.map(async s => {
          const content = await readContent(s);
          return `### ${s.name}\n\n${content}`;
        }),
      );

      const session = {
        ...ctx.session,
        messages: [
          ...ctx.session.messages,
          makeSystemMsg(`Injected skill context:\n\n${blocks.join('\n\n---\n\n')}`),
        ],
      };
      return { ...ctx, session };
    },
  };
}
