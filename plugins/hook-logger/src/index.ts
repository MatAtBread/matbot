import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, Message, MessageContent } from '@matatbread/matbot-plugin-api';

// A diagnostic plugin that registers one hook on each of the five channels and logs when it fires.
// Most handlers are pure observers (return nothing). The `screen` hook additionally demonstrates a
// durable injection: when the latest user message contains "fnarr", it appends a prompt *fragment*
// to that user turn (a distinct block, leaving the user's typed text intact) and returns the mutated
// session — so it persists. Riding the user turn puts it at the tail (high attention) the turn it's
// added, stays durable thereafter, and a later "fnarr" re-injects at the new tail to refresh salience.

const TAG = '[hook-logger]';
const FNARR_PROMPT = "Ask the user 'are we having fun yet?'";

function latestUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join(' ');
}

function lastTextOfRole(messages: readonly Message[], role: Message['role']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === role) return textOf(m.content);
  }
  return '';
}

// Hard-redaction demo: blank out key-shaped material wherever it appears in a tool result, however
// deeply nested. The bash tool in particular is good at surfacing secrets from a filesystem.
function redactString(s: string): string {
  return s.replace(/((?:[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PWD).*)\s*[=:]\s*)(\S+)/gi, '$1[**********]');
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    services.hooks.register({
      on: 'screen',
      handler(ctx) {
        const msgs = ctx.session.messages;
        console.warn(`${TAG} screen      session=${ctx.session.id} msgs=${msgs.length} provider=${ctx.config.provider}`);

        const idx = latestUserIndex(msgs);
        if (idx === -1) return;
        const user = msgs[idx]!;

        if (!textOf(user.content).toLowerCase().includes('fnarr')) return;
        // Guard against double-appending the same fragment to a message screened more than once.
        if (user.content.some(c => c.type === 'text' && c.text === FNARR_PROMPT)) return;

        console.warn(`${TAG} screen      "fnarr" detected — appending durable prompt fragment to the user turn`);
        // origin: 'robo' marks this one block as machine-authored — the human's own blocks in the same
        // turn stay unmarked, so a frontend renders "fnarr!" as the user and this fragment agent-side.
        const fragment: MessageContent = { type: 'text', text: FNARR_PROMPT, origin: 'robo' };
        const updated: Message = { ...user, content: [...user.content, fragment] };
        ctx.session.messages = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)];
//        return { session: { ...ctx.session, messages: [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)] } };
      },
    });

    services.hooks.register({
      on: 'contribute',
      handler(ctx) {
        console.warn(`${TAG} contribute  outgoing=${ctx.outgoing.length} (session=${ctx.session.id})`);
      },
    });

    services.hooks.register({
      on: 'toolcall',
      handler(ctx) {
        console.warn(`${TAG} toolcall    tool=${ctx.tool.name} callId=${ctx.toolCall.id}`);
      },
    });

    services.hooks.register({
      on: 'toolresult',
      handler(ctx) {
        // Audit (read-only): every tool result gets timing + size logged alongside the call.
        const before = JSON.stringify(ctx.result) ?? '';
        console.warn(`${TAG} toolresult  tool=${ctx.tool.name} durationMs=${ctx.durationMs} isError=${ctx.isError} bytes=${before.length}`);

        // Redact (transform): blank key-shaped material before the result is recorded or sent to the LLM.
        const redacted = redactDeep(ctx.result);
        if ((JSON.stringify(redacted) ?? '') !== before) {
          console.warn(`${TAG} toolresult  redacted key-shaped material from ${ctx.tool.name} result`);
          return { result: redacted };
        }
      },
    });

    services.hooks.register({
      on: 'followup',
      handler(ctx) {
        const msgs = ctx.session.messages;
        console.warn(`${TAG} followup    session=${ctx.session.id} depth=${ctx.resubmitDepth} lastRole=${msgs.at(-1)?.role}`);

        // Only respond to the original human turn — not to our own robo turn's response (which could
        // itself mention 42), so this fires once. The runner also hard-caps resubmitDepth regardless.
        if (ctx.resubmitDepth > 0) return;
        if (!lastTextOfRole(msgs, 'assistant').includes('42')) return;

        console.warn(`${TAG} followup    "42" detected — resubmitting robo-turn`);
        return { resubmit: { content: [{ type: 'text', text: 'Ah, the meaning of life!' }] } };
      },
    });
  },
};
