import type {
  MatbotPluginSpec, MatbotMachine, Principal, ProviderAdapter, ProviderConfig, Session, PromptFn, FormField,
  ToolExecutor, ToolContract, ToolResultOf,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // telegram_provider discriminates on `action`; get and set both return the active provider name.
    telegram_provider:
      | ToolContract<{ provider: string | null }, { action: 'get' }>
      | ToolContract<{ provider: string | null }, { action: 'set'; provider: string }>;
    telegram_open_door: ToolContract<{ open_until: string }, Record<string, never>>;  // ISO time the join window stays open until
    telegram_send:      ToolContract<{ sent: number }, { text: string; chatId?: number }>;  // how many chats the notification reached
  }
}
import {
  createSession, resolveProviderFactory, runAs,
} from '@matatbread/matbot-core';
import { getUpdates, sendChatAction, sendMessage } from './bot.js';

const PLUGIN_NAME = 'frontend-telegram';
const SETTINGS_KEY_PROVIDER = 'provider';
const SETTINGS_KEY_KNOWN = 'knownChats';

interface ActiveProvider {
  name:   string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
}

// Module-level state: readable/writable by the tools regardless of where setup() is in scope.
let teardownAc:    AbortController | undefined;
let activeProvider: ActiveProvider;
let servicesRef:   MatbotMachine | undefined;
let botTokenRef:   string | undefined;
const knownChats = new Set<number>(); // populated as chats interact with the bot
let openDoor = 0;

async function buildProvider(name: string, services: MatbotMachine): Promise<ActiveProvider> {
  const rawConfig = services.providers.get(name);
  if (!rawConfig) throw new Error(`Provider "${name}" not found`);

  const resolvedCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawConfig.credentials ?? {})) {
    resolvedCreds[k] = await services.Vault.resolve(v);
  }
  const config: ProviderConfig = { ...rawConfig, credentials: resolvedCreds };
  const adapter = resolveProviderFactory(config.module)(config);
  return { name, adapter, config };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  tools: [
    {
      name:        'telegram_provider',
      description: `Get or set the LLM provider the Telegram bot uses. A 'set' is persisted and restored on restart.`,
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type:        'string',
            enum:        ['get', 'set'],
            description: 'get: return the current provider. set: switch to a different provider.',
          },
          provider: {
            type:        'string',
            description: 'Provider name as defined in matbot.yaml (set only).',
          },
        },
      },
      executor: {
        async *execute(input: unknown) {
          const act = input as { action: 'get' | 'set'; provider?: string };

          if (act.action === 'get') {
            yield { type: 'result' as const, value: { provider: activeProvider?.name ?? null } };
            return;
          }

          if (act.action === 'set') {
            const svc = servicesRef;
            if (!svc) { yield { type: 'error' as const, message: 'Plugin not active' }; return; }
            if (!act.provider) { yield { type: 'error' as const, message: "'set' requires a provider name." }; return; }

            try {
              activeProvider = await buildProvider(act.provider, svc);
              await svc.settings().set(SETTINGS_KEY_PROVIDER, act.provider);
              yield { type: 'result' as const, value: { provider: act.provider } };
            } catch (e) {
              yield { type: 'error' as const, message: String(e) };
            }
            return;
          }

          yield { type: 'error' as const, message: `Unknown telegram_provider action "${(act as { action: string }).action}". Expected 'get' or 'set'.` };
        },
      } satisfies ToolExecutor<ToolResultOf<'telegram_provider'>>,
    },
    {
      name:        'telegram_open_door',
      description: 'Open the door for new chats to join the bot channel. The door remains open for 30 seconds or until the first message from a new user is received, whichever comes first.',
      inputSchema: { type: 'object', properties: {} },
      executor: {
        async *execute() {
          openDoor = Date.now();
          yield { type: 'result' as const, value: { open_until: new Date(openDoor + 30_000).toISOString() } };
        },
      } satisfies ToolExecutor<ToolResultOf<'telegram_open_door'>>,
    },
    {
      name:        'telegram_send',
      description: 'Send an out-of-band notification to Telegram, outside of any session. The message is prepended with 🔔. Sends to all chats that have previously contacted the bot, or to a specific chat if chatId is given.',
      inputSchema: {
        type: 'object',
        properties: {
          text:   { type: 'string',  description: 'Notification text' },
          chatId: { type: 'integer', description: 'Target chat ID. Omit to broadcast to all known chats.' },
        },
        required: ['text'],
      },
      executor: {
        async *execute(input: unknown) {
          const token = botTokenRef;
          if (!token) { yield { type: 'error' as const, message: 'Telegram plugin not active' }; return; }

          const { text, chatId } = input as { text: string; chatId?: number };
          const message = `🔔 ${text}`;
          const targets = chatId !== undefined ? [chatId] : [...knownChats];

          if (targets.length === 0) {
            yield { type: 'result' as const, value: { sent: 0 } };
            return;
          }

          let sent = 0;
          for (const id of targets) {
            try {
              await sendMessage(token, id, message);
              sent++;
            } catch (e) {
              yield { type: 'stderr' as const, chunk: `Failed to send to chat ${id}: ${e}\n` };
            }
          }
          yield { type: 'result' as const, value: { sent } };
        },
      } satisfies ToolExecutor<ToolResultOf<'telegram_send'>>,
    },
  ],

  async setup(services: MatbotMachine) {
    let botToken: string;
    try {
      botToken = await services.Vault.resolve('${TELEGRAM_API_KEY}');
    } catch {
      console.warn('[frontend-telegram] TELEGRAM_API_KEY not set; skipping');
      return;
    }

    const sessions = services.sessions!;
    if (!sessions) throw new Error('frontend-telegram requires services.sessions');
    const run = services.run ?? (() => { throw new Error('frontend-telegram requires services.run'); })();

    services.registerFrontend({ name: PLUGIN_NAME });

    servicesRef = services;
    botTokenRef = botToken;

    const settings = services.settings();
    for (const id of await settings.get<number[]>(SETTINGS_KEY_KNOWN) ?? []) {
      knownChats.add(id);
    }

    // Restore a previously persisted provider, or fall back to the first configured one.
    const savedName    = await settings.get<string>(SETTINGS_KEY_PROVIDER);
    const fallbackName: string = (
      [...services.providers.keys()][0] ??
      (() => { throw new Error('frontend-telegram: no providers configured'); })()
    );
    const initialName = savedName !== undefined && services.providers.has(savedName)
      ? savedName
      : fallbackName;

    activeProvider = await buildProvider(initialName, services);


    const ac   = new AbortController();
    teardownAc = ac;

    async function handleMessage(chatId: number, text: string, senderName?: string): Promise<void> {
      if (!knownChats.has(chatId)) {
        // A new user. Admit them only as the first-ever chat, or while the door is open.
        if (knownChats.size === 0 || (openDoor && (Date.now() - openDoor) < 30_000)) {
          knownChats.add(chatId);
          openDoor = 0; // a new user has joined — close the door immediately
          settings.set(SETTINGS_KEY_KNOWN, [...knownChats]).catch(() => {});
        } else {
          return; // Door closed and chat unknown — ignore.
        }
      }

      // Snapshot the active provider name so a mid-run switch doesn't affect this call. The runner
      // resolves the adapter from the name, so we no longer build it here.
      const providerName = activeProvider.name;
      const principal: Principal = { id: `telegram-${senderName ?? chatId}`, type: 'user'};
      try {
        sendChatAction(botToken, chatId, 'typing').catch(() => {});

        // Look up or create a persistent session for this chat. The runner appends + persists the
        // user message when the turn starts, so we only ensure the session exists here.
        const sessionKey = `chat:${chatId}`;
        const storedId   = await settings.get<string>(sessionKey);
        let session: Session | null = storedId !== undefined ? await sessions.get(storedId) : null;
        // If the session was hidden/archived in the web UI, treat it as gone
        // so a new session is created with the current naming convention
        if (session?.status !== 'active') session = null;
        if (!session) {
          session = createSession({ ownerPrincipal: principal });
          // Name the session after the sender so it's identifiable in the web UI
          const name = senderName || 'Telegram';
          session.title = `${name} on Telegram`;
          await sessions.set(session.id, session);
          await settings.set(sessionKey, session.id);
        }

        // Keep the typing indicator alive; Telegram expires it after ~5 s.
        const typingInterval = setInterval(
          () => { void sendChatAction(botToken, chatId, 'typing'); },
          4_000,
        );

        let responseText = '';
        try {
          // Concurrent messages for this chat hit the same session, so the runner queues them — no
          // per-chat lock needed. We render only our own turn and its descendants (rootTraceId), so
          // concurrent submissions don't cross-render.
          const view = await run.open({
            sessionId: session.id,
            signal:    ac.signal,
            content:   [{ type: 'text', text }],
            provider:  providerName,
            principal,
            // ── Interactive prompts: deliberately NOT implemented ───────────────────────────────
            // This telegram frontend is a *demonstrator* that stress-tests the frontend API; it does
            // not do `prompt`. The stub auto-accepts the default, so an `ask_user` (or tool-collision)
            // prompt resolves *silently* — the model proceeds as if answered while the chat saw no
            // question. That desync is the one place this frontend lies, and the obvious next build.
            // Sketch (exercise for the reader):
            //
            //   1. A per-chat pending-prompt slot, module-scoped:
            //        const pending = new Map<number, (answer: string) => void>();
            //   2. The prompt impl sends the question and parks a resolver (instead of resolving now):
            //        prompt: (p) => {
            //          const q = typeof p === 'string' ? p : p.label;   // + render p.options as buttons
            //          void sendMessage(botToken, chatId, q);
            //          return new Promise<string>(res => pending.set(chatId, res));
            //        }
            //   3. The dispatch loop (below) routes the *next* message for a chat that has a parked
            //      prompt to its resolver, instead of starting a fresh turn:
            //        const resolve = pending.get(chatId);
            //        if (resolve) { pending.delete(chatId); resolve(text); continue; }
            //
            // Wrinkles to handle: cancel (`/cancel` → reject with PromptCancelledError + run.cancelTurn),
            // a timeout (a turn can't hold the pump forever waiting on a human), and FormField `options`
            // as an inline keyboard. This is the inverse of `followup`: there matbot continues a turn
            // on its own; here it pauses one to wait on the human.
            prompt:    ((p: string | FormField, def?: string) =>
              Promise.resolve(typeof p === 'string' ? (def ?? '') : (p.default ?? ''))) as PromptFn,
          });
          // Drain to session idle, not just our own turn's `done`: a `followup` resubmission spawned
          // by our turn runs as a *later* turn with its own traceId. We adopt the turns descended from
          // ours (rootTraceId lineage) and ignore any concurrent submission's turns. Each turn's
          // assistant text is sent when it completes; a turn's machine-authored (robo) content is sent
          // as its own bot message — Telegram can't echo a user turn, so robo content surfaces "from
          // the LLM", which is what it is (matbot chose to continue the turn).
          const owned = new Set<string>([view.traceId!]);
          for await (const event of view.events) {
            if (event.type === 'idle') break;
            if (event.type === 'queued') {
              if (owned.has(event.rootTraceId)) {
                owned.add(event.traceId);
                const roboText = event.content
                  .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text' && c.origin === 'robo')
                  .map(c => c.text).join('\n').trim();
                if (roboText) await sendMessage(botToken, chatId, `🤖 ${roboText}`);
              }
              continue;
            }
            if (!owned.has(event.traceId)) continue;
            if (event.type === 'text-delta') responseText += event.delta;
            else if (event.type === 'done' || event.type === 'aborted'
                     || event.type === 'error' || event.type === 'cancelled') {
              if (responseText.trim()) await sendMessage(botToken, chatId, responseText);
              responseText = '';
            }
            // Swallow: thinking, usage, tool:start/stdout/stderr/end, file
          }
        } finally {
          clearInterval(typingInterval);
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          console.warn(`[frontend-telegram] Error for chat ${chatId}: ${e}\n`);
          try {
            await sendMessage(botToken, chatId, 'An error occurred. Please try again.');
          } catch { /* ignore send failures */ }
        }
      }
    }

    // Background sub-agent runs share the bot token with the foreground process; two concurrent
    // getUpdates long-polls on the same token make Telegram return 409 Conflict. So a sub-agent
    // skips polling (the foreground owner keeps it) but still has a live setup() — it can send.
    if (services.isSubAgent()) {
      console.warn(`[frontend-telegram] Bot started in send-only mode (sub-agent; polling skipped)\n`);
      return;
    }

    // Long-poll loop — runs until teardown.
    void (async () => {
      let offset = 0;
      while (!ac.signal.aborted) {
        try {
          const updates = await getUpdates(botToken, offset, 30, ac.signal);
          for (const update of updates) {
            offset = update.update_id + 1;
            const msg = update.message;
            if (msg?.text) {
              // Establish this message's principal at the dispatch entry so the session/settings
              // store access inside handleMessage runs under it (the turn itself is scoped by pump).
              const senderName = msg.from?.first_name || msg.from?.username;
              const principal: Principal = { id: `telegram-${senderName ?? msg.chat.id}`, type: 'user'};
              void runAs(principal,
                () => handleMessage(msg.chat.id, msg.text!, senderName));
            }
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          console.warn(`[frontend-telegram] Poll error: ${e}\n`);
          // Brief back-off; abort exits the wait immediately.
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, 2_000);
            ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      }
    })();

    console.warn(`[frontend-telegram] Bot started (provider: ${initialName})\n`);
  },

  async teardown() {
    // Aborting the shared signal cancels any in-flight turn via the runner.
    teardownAc?.abort();
    teardownAc     = undefined;
    servicesRef    = undefined;
    botTokenRef    = undefined;
    knownChats.clear();
  },
};
