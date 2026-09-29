import type { PromptFn, FormField, SessionRunner } from '@matatbread/matbot-plugin-api';
import { CONFIRM_NO, CONFIRM_YES, optionLabel, optionValue, promptCancelledError } from '@matatbread/matbot-plugin-api';
import { answerCallbackQuery, editMessageText, sendMessage } from './bot.js';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUser } from './bot.js';

/**
 * A turn's `PromptFn`, rendered in a chat. A human in Telegram may answer hours later or never, and
 * the pump holds the machine for as long as a prompt is parked — deferred work (a staged backend swap,
 * a session edit) cannot land until it settles. So an unanswered prompt is cancelled after this long,
 * which the host treats as the user giving up.
 */
const PROMPT_TIMEOUT_MS = 10 * 60_000;

interface Choice { value: string; label: string }

interface PendingPrompt {
  chatId:    number;
  sessionId: string;
  /** Who may answer: the sender whose message started the turn. Undefined only for a message with
   *  no `from` (a channel post), where there is nobody narrower to hold it to. */
  fromId:    number | undefined;
  messageId: number;
  question:  string;
  /** Answerable by button, addressed by index — `callback_data` is capped at 64 bytes, and an
   *  option's value (a plugin URL, a subject) will not fit. */
  choices:   Choice[];
  /** A reply to the prompt message answers it with the reply's text. */
  typed:     boolean;
  /** A plain next message from the sender answers it too — a free-text question, where anything
   *  they send next is the answer. With buttons on offer, a plain message means they moved on. */
  plain:     boolean;
  resolve(answer: string, shown: string): void;
  cancel(why: string): void;
}

export interface Prompter {
  /** The `PromptFn` for one submission, bound to the chat, session and sender it came from. */
  promptFor(chatId: number, sessionId: string, from: TelegramUser | undefined): PromptFn;
  onButton(cq: TelegramCallbackQuery): Promise<void>;
  /** Route a message to a parked prompt. `answered` means it was consumed and must not start a turn. */
  onMessage(msg: TelegramMessage): 'answered' | 'none';
  /** Cancel every prompt parked in a chat, abandoning the turns that asked. Returns how many. */
  cancelChat(chatId: number, why: string): number;
  pending(chatId: number): boolean;
  closeAll(): void;
}

/** Labels are authored as markdown (`Install plugin **"…"**?`); the chat is sent as plain text. */
const plain = (s: string): string => s.replace(/\*\*/g, '');

const nameOf = (u: TelegramUser): string => u.first_name ?? u.username ?? String(u.id);

export function createPrompter(botToken: string, run: SessionRunner): Prompter {
  const prompts = new Map<string, PendingPrompt>();
  let seq = 0;

  const inChat = (chatId: number): PendingPrompt[] => [...prompts.values()].filter(p => p.chatId === chatId);

  const close = (nonce: string, p: PendingPrompt, outcome: string): void => {
    prompts.delete(nonce);
    editMessageText(botToken, p.chatId, p.messageId, `${p.question}\n\n${outcome}`).catch(() => {});
  };

  function promptFor(chatId: number, sessionId: string, from: TelegramUser | undefined): PromptFn {
    return ((p: string | FormField, defaultValue?: string): Promise<string> => {
      const field    = typeof p === 'string' ? undefined : p;
      const question = plain(field?.label ?? (p as string));
      const def      = field ? field.default : defaultValue;

      // Refused rather than asked: whatever is typed stays in the chat history, on Telegram's servers
      // and every device the chat syncs to. An ordinary error, not a cancel — the tool fails, the turn
      // goes on, and the model can say where the secret should be entered instead.
      if (field?.type === 'password') {
        return Promise.reject(new Error(`Telegram cannot collect a secret ("${question}"): it would stay in the chat history. Enter it through the web UI or the CLI instead.`));
      }

      const choices: Choice[] =
          field?.type === 'select'  ? (field.options ?? []).map(o => ({ value: optionValue(o), label: optionLabel(o) }))
        : field?.type === 'confirm' ? [{ value: CONFIRM_YES, label: 'Yes' }, { value: CONFIRM_NO, label: 'No' }]
        : def !== undefined && def !== '' ? [{ value: def, label: `Use "${def}"` }]
        : [];
      const freeText = field === undefined || field.type === 'text';
      const typed    = freeText || (field?.type === 'select' && field.allowOther === true);
      const hint     = freeText ? '\n\n(Reply with your answer, or /cancel.)'
                     : typed    ? '\n\n(Pick one, reply to this message with your own answer, or /cancel.)'
                     :            '\n\n(Pick one, or /cancel.)';

      const nonce = (++seq).toString(36);
      const markup = choices.length > 0
        ? { inline_keyboard: choices.map((c, i) => [{ text: c.label, callback_data: `p:${nonce}:${i}` }]) }
        : { force_reply: true, selective: true };

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => entry.cancel('⌛ No answer — cancelled.'), PROMPT_TIMEOUT_MS);
        const entry: PendingPrompt = {
          chatId, sessionId, fromId: from?.id, messageId: 0, question, choices, typed, plain: freeText,
          resolve(answer, shown) {
            clearTimeout(timer);
            close(nonce, entry, `→ ${shown}`);
            resolve(answer || def || '');
          },
          cancel(why) {
            clearTimeout(timer);
            close(nonce, entry, why);
            reject(promptCancelledError());
            run.cancelTurn(sessionId);
          },
        };
        prompts.set(nonce, entry);
        sendMessage(botToken, chatId, question + hint, markup).then(
          id => { entry.messageId = id; },
          e  => { clearTimeout(timer); prompts.delete(nonce); reject(e instanceof Error ? e : new Error(String(e))); },
        );
      });
    }) as PromptFn;
  }

  async function onButton(cq: TelegramCallbackQuery): Promise<void> {
    const [tag, nonce = '', index = ''] = (cq.data ?? '').split(':');
    const p      = tag === 'p' ? prompts.get(nonce) : undefined;
    const choice = p?.choices[Number(index)];
    if (!p || !choice) { await answerCallbackQuery(botToken, cq.id, 'This question has expired.'); return; }
    // In a group anyone can press a button, and the gate's buttons include standing permission for
    // every future install — so only the person whose message is being served may answer.
    if (p.fromId !== undefined && cq.from.id !== p.fromId) {
      await answerCallbackQuery(botToken, cq.id, 'Only the person who asked can answer this.');
      return;
    }
    p.resolve(choice.value, `${choice.label} (${nameOf(cq.from)})`);
    await answerCallbackQuery(botToken, cq.id);
  }

  function onMessage(msg: TelegramMessage): 'answered' | 'none' {
    const mine = inChat(msg.chat.id).filter(p => p.fromId === undefined || p.fromId === msg.from?.id);
    if (mine.length === 0) return 'none';
    const text    = msg.text ?? msg.caption;
    const replyTo = msg.reply_to_message?.message_id;

    const target = replyTo !== undefined
      ? mine.find(p => p.messageId === replyTo && p.typed)
      : mine.find(p => p.plain);
    if (target && text) {
      target.resolve(text, 'answered');
      return 'answered';
    }

    // They sent something else while a question waited on buttons: they have moved on. Leaving it
    // parked would queue this message behind a turn nobody is going to unblock, so the question is
    // abandoned (never answered with its default — for a gate that can mean "allow") and this
    // message becomes a turn of its own.
    for (const p of mine) p.cancel('✖ Cancelled — you sent another message.');
    return 'none';
  }

  function cancelChat(chatId: number, why: string): number {
    const mine = inChat(chatId);
    for (const p of mine) p.cancel(why);
    return mine.length;
  }

  return {
    promptFor, onButton, onMessage, cancelChat,
    pending: chatId => inChat(chatId).length > 0,
    closeAll() { for (const p of [...prompts.values()]) p.cancel('✖ The bot stopped.'); },
  };
}
