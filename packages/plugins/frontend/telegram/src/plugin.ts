import type {
  MatbotPlugin, MatbotServices, Principal, ProviderAdapter, ProviderConfig, Session, PromptFn, FormField,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import {
  appendMessage, createMessage, createSession, resolveProviderFactory, runSession,
} from '@matatbread/matbot-core';
import process from 'node:process';
import { getUpdates, sendChatAction, sendMessage } from './bot.js';

const PLUGIN_NAME = 'frontend-telegram';
const SETTINGS_KEY_PROVIDER = 'provider';
const SETTINGS_KEY_KNOWN = 'knownChats';

const PRINCIPAL: Principal = {
  id:   'telegram-user',
  type: 'user',
};

interface ActiveProvider {
  name:   string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
}

// Module-level state: readable/writable by the tools regardless of where setup() is in scope.
let teardownAc:    AbortController | undefined;
const messageBusy = new Map<number, Promise<void>>();
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

export const plugin: MatbotPlugin = {
  name:       PLUGIN_NAME,
  apiVersion: PLUGIN_API_VERSION,

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
    let botToken: string;
    try {
      botToken = await services.vault.resolve('${env:TELEGRAM_API_KEY}');
    } catch {
      console.warn('[frontend-telegram] TELEGRAM_API_KEY not set; skipping');
      return;
    }

    const sessions = services.sessions!;
    if (!sessions) throw new Error('frontend-telegram requires services.sessions');

    services.registerFrontend({ name: PLUGIN_NAME });

    servicesRef = services;
    botTokenRef = botToken;

    const settings = services.settings(PLUGIN_NAME);
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
      if (messageBusy.has(chatId)) {
        await messageBusy.get(chatId);
      }

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

      // Snapshot the active provider so a mid-run switch doesn't affect this call.
      const prov = activeProvider;
      try {
        async function processMessage() {
          sendChatAction(botToken, chatId, 'typing').catch(() => {});

          // Look up or create a persistent session for this chat.
          const sessionKey = `chat:${chatId}`;
          const storedId   = await settings.get<string>(sessionKey);
          let session: Session | null = storedId !== undefined ? await sessions.get(storedId) : null;
          // If the session was hidden/archived in the web UI, treat it as gone
          // so a new session is created with the current naming convention
          if (session?.status !== 'active') session = null;
          if (!session) {
            session = createSession({ ownerPrincipal: PRINCIPAL });
            // Name the session after the sender so it's identifiable in the web UI
            const name = senderName || 'Telegram';
            session.title = `${name} on Telegram`;
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
              // Stub: auto-accepts the default. A future Telegram plugin could send the
              // question (or FormField) to the chat and resolve with the user's next message —
              // that one change makes both tool prompts and tool-collision prompts interactive here.
              prompt:       ((p: string | FormField, def?: string) =>
                Promise.resolve(typeof p === 'string' ? (def ?? '') : (p.default ?? ''))) as PromptFn,
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
        }

        messageBusy.set(chatId, processMessage().finally(() => messageBusy.delete(chatId)).catch(() => {}));
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
              void handleMessage(msg.chat.id, msg.text, msg.from?.first_name || msg.from?.username);
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
    // Wait for any in-flight message handlers to complete before resolving.
    if (messageBusy.size > 0) {
      await Promise.allSettled([...messageBusy.values()]);
    }
    messageBusy.clear();
    servicesRef    = undefined;
    botTokenRef    = undefined;
    knownChats.clear();
  },
};
