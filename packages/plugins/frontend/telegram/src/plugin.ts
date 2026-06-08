import type {
  MatbotPluginSpec, MatbotServices, Principal, ProviderAdapter, ProviderConfig, Session, PromptFn, FormField,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
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
let servicesRef:   MatbotServices | undefined;
let botTokenRef:   string | undefined;
const knownChats = new Set<number>(); // populated as chats interact with the bot
let openDoor = 0;

async function buildProvider(name: string, services: MatbotServices): Promise<ActiveProvider> {
  const rawConfig = services.providers.get(name);
  if (!rawConfig) throw new Error(`Provider "${name}" not found`);

  const resolvedCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawConfig.credentials ?? {})) {
    resolvedCreds[k] = await services.vault.resolve(v);
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
      description: `Get or set the LLM provider the Telegram bot uses. A 'set' is persisted and restored on restart.

  type TelegramProvider =
    | { action: 'get' }
    | { action: 'set'; provider: string };  // provider name as defined in matbot.yaml`,
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
      },
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
      },
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
      },
    },
  ],

  async setup(services: MatbotServices) {
    let botToken: string;
    try {
      botToken = await services.vault.resolve('${TELEGRAM_API_KEY}');
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
          // Concurrent messages for this chat hit the same session, so the runner queues them —
          // no per-chat lock needed. We only render this submission's turn, hence the traceId filter.
          const view = await run.open({
            sessionId: session.id,
            signal:    ac.signal,
            content:   [{ type: 'text', text }],
            provider:  providerName,
            principal,
            // Stub: auto-accepts the default. A future Telegram plugin could send the question (or
            // FormField) to the chat and resolve with the user's next message — that one change makes
            // both tool prompts and tool-collision prompts interactive here.
            prompt:    ((p: string | FormField, def?: string) =>
              Promise.resolve(typeof p === 'string' ? (def ?? '') : (p.default ?? ''))) as PromptFn,
          });
          for await (const event of view.events) {
            if (event.type === 'idle') continue; // session-level lifecycle signal, not this turn's
            if (event.traceId !== view.traceId) continue;
            if (event.type === 'text-delta') responseText += event.delta;
            if (event.type === 'done' || event.type === 'aborted'
                || event.type === 'error' || event.type === 'cancelled') break;
            // Swallow: thinking, usage, tool:start/stdout/stderr/end, robo-user, file
          }
        } finally {
          clearInterval(typingInterval);
        }

        if (responseText.trim()) {
          await sendMessage(botToken, chatId, responseText);
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
