import type {
  MatbotPlugin, MatbotServices, Principal, ProviderAdapter, ProviderConfig, Session,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import {
  appendMessage, createMessage, createSession, resolveProviderFactory, runSession,
} from '@matatbread/matbot-core';
import process from 'node:process';
import { getUpdates, sendChatAction, sendMessage } from './bot.js';

const PLUGIN_NAME = 'frontend-telegram';
const SETTINGS_KEY_PROVIDER = 'provider';

const PRINCIPAL: Principal = {
  id:       'telegram-user',
  type:     'user',
  grants:   [
    { capability: 'network' },
    { capability: 'filesystem' },
    { capability: 'spawn' },
    { capability: 'container' },
    { capability: 'audit:read' },
  ],
  contexts: [],
};

interface ActiveProvider {
  name:   string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
}

// Module-level state: readable/writable by the tools regardless of where setup() is in scope.
let teardownAc:    AbortController | undefined;
let activeProvider: ActiveProvider | undefined;
let servicesRef:   MatbotServices | undefined;
let botTokenRef:   string | undefined;
const knownChats = new Set<number>(); // populated as chats interact with the bot

async function buildProvider(name: string, services: MatbotServices): Promise<ActiveProvider> {
  const rawConfig = services.providers.get(name);
  if (!rawConfig) throw new Error(`Provider "${name}" not found`);

  const resolvedCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawConfig.credentials)) {
    resolvedCreds[k] = await services.vault.resolve(v);
  }
  const config: ProviderConfig = { ...rawConfig, credentials: resolvedCreds };
  const adapter = resolveProviderFactory(config.type)(config);
  return { name, adapter, config };
}

export const plugin: MatbotPlugin = {
  name:       PLUGIN_NAME,
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Telegram bot frontend',
    credentials: ['TELEGRAM_API_KEY'],
  },

  tools: [
    {
      name:        'telegram_get_provider',
      description: 'Get the name of the LLM provider currently used by the Telegram bot.',
      inputSchema: { type: 'object', properties: {} },
      executor: {
        async *execute() {
          yield { type: 'result' as const, value: { provider: activeProvider?.name ?? null } };
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
    {
      name:        'telegram_set_provider',
      description: 'Set the LLM provider used by the Telegram bot. The selection is persisted and restored on restart.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type:        'string',
            description: 'Provider name as defined in matbot.yaml',
          },
        },
        required: ['required'],
      },
      executor: {
        async *execute(input: unknown) {
          const svc = servicesRef;
          if (!svc) { yield { type: 'error' as const, message: 'Plugin not active' }; return; }

          const { provider: name } = input as { provider: string };
          try {
            activeProvider = await buildProvider(name, svc);
            await svc.settings(PLUGIN_NAME).set(SETTINGS_KEY_PROVIDER, name);
            yield { type: 'result' as const, value: { provider: name } };
          } catch (e) {
            yield { type: 'error' as const, message: String(e) };
          }
        },
      },
    },
  ],

  async setup(services: MatbotServices) {
    const botToken = process.env['TELEGRAM_API_KEY']!;
    if (!botToken) {
      console.warn('[frontend-telegram] TELEGRAM_API_KEY not set; skipping');
      return;
    }

    const sessions = services.sessions!;
    if (!sessions) throw new Error('frontend-telegram requires services.sessions');

    services.registerFrontend?.();

    servicesRef = services;
    botTokenRef = botToken;

    const settings = services.settings(PLUGIN_NAME);

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

    const busy = new Set<number>();
    const ac   = new AbortController();
    teardownAc = ac;

    async function handleMessage(chatId: number, text: string): Promise<void> {
      if (busy.has(chatId)) {
        await sendMessage(botToken, chatId, 'Please wait — still processing your previous message.');
        return;
      }
      busy.add(chatId);
      knownChats.add(chatId);

      // Snapshot the active provider so a mid-run switch doesn't affect this call.
      const prov = activeProvider;
      if (!prov) { busy.delete(chatId); return; }

      try {
        void sendChatAction(botToken, chatId, 'typing');

        // Look up or create a persistent session for this chat.
        const sessionKey = `chat:${chatId}`;
        const storedId   = await settings.get<string>(sessionKey);
        let session: Session | null = storedId !== undefined ? await sessions.get(storedId) : null;
        if (!session) {
          session = createSession({ ownerPrincipal: PRINCIPAL });
          await sessions.set(session.id, session);
          await settings.set(sessionKey, session.id);
        }

        const traceId = crypto.randomUUID();
        const userMsg = createMessage({ role: 'user', content: [{ type: 'text', text }], traceId });
        session = appendMessage(session, userMsg);
        await sessions.set(session.id, session);

        // Keep the typing indicator alive; Telegram expires it after ~5 s.
        const typingInterval = setInterval(
          () => { void sendChatAction(botToken, chatId, 'typing'); },
          4_000,
        );

        let responseText = '';
        try {
          for await (const event of runSession({
            session,
            config:         { principal: PRINCIPAL, provider: prov.name, traceId },
            provider:       prov.adapter,
            providerConfig: prov.config,
            ...(services.tools         ? { tools: new Map(services.tools.list().map(t => [t.name, t])) } : {}),
            store:          sessions,
            ...(services.hooks         ? { hooks:         services.hooks         } : {}),
            ...(services.systemContext ? { systemContext: services.systemContext } : {}),
            ...(services.workdir       ? { workdir:       services.workdir       } : {}),
            ...(services.files         ? { files:         services.files         } : {}),
            ...(services.configPath    ? { configPath:    services.configPath    } : {}),
            signal:       ac.signal,
            prompt:       (_q, def) => Promise.resolve(def ?? ''),
            loadPlugin:   services.loadPlugin.bind(services),
            unloadPlugin: services.unloadPlugin.bind(services),
          })) {
            if (event.type === 'text-delta') {
              responseText += event.delta;
            }
            // Swallow: thinking, usage, tool:start/stdout/stderr/end, robo-user, file, done, aborted
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
      } finally {
        busy.delete(chatId);
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
              void handleMessage(msg.chat.id, msg.text);
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
    teardownAc?.abort();
    teardownAc     = undefined;
    activeProvider = undefined;
    servicesRef    = undefined;
    botTokenRef    = undefined;
    knownChats.clear();
  },
};
