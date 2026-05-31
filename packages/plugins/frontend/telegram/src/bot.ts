export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
}

const API = 'https://api.telegram.org';

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
): Promise<void> {
  for (const chunk of splitText(text)) {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendMessage failed: ${res.status} ${body}`);
    }
  }
}

export async function sendChatAction(
  botToken: string,
  chatId: number,
  action = 'typing',
): Promise<void> {
  await fetch(`${API}/bot${botToken}/sendChatAction`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action }),
  });
}

export async function getUpdates(
  botToken: string,
  offset: number,
  timeout: number,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const url =
    `${API}/bot${botToken}/getUpdates` +
    `?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`getUpdates failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!data.ok) throw new Error('Telegram getUpdates returned ok=false');
  return data.result;
}

// Telegram limits messages to 4096 UTF-16 code units.
function *splitText(text: string, max = 4096): Iterable<string> {
  if (text.length <= max) {
    yield text;
    return;
  }
  let i = 0;
  while(i < text.length) {
    const boundaries = [
      text.lastIndexOf(' ', i + max) + 1,
      text.lastIndexOf('\n', i + max) + 1,
      text.lastIndexOf('\t', i + max) + 1
    ].filter(v => v > 0 && v < max);
    const end = boundaries.length ? Math.max(...boundaries) : i + max;
    yield text.slice(i, end);
    i = end;
  }
}
