import type { Principal, Session, MessageContent, UserContent, Usage, SessionRunner, PromptFn } from '@matatbread/matbot-core';
import { usageByProvider } from '@matatbread/matbot-core';
import process             from 'node:process';
import { cyanErr, cyanOut, dim, write, yellow } from './terminal.js';

// One marker block → a human-facing line. The dispatcher's hook-failure marker is a warning
// (amber); any other marker is shown dimmed and generic.
function formatMarker(part: Extract<MessageContent, { type: 'marker' }>): string {
  if (part.creator === 'matbot-hooks') {
    const data = (part.data ?? {}) as { channel?: string; pluginName?: string; message?: string };
    const who  = data.pluginName !== undefined ? ` (${data.pluginName})` : '';
    return yellow(`⚠  ${data.channel ?? 'hook'} hook${who} failed and was skipped: ${data.message ?? 'unknown error'}`);
  }
  return dim(`${String.fromCodePoint(0x1F4CC)} ${part.creator}: ${JSON.stringify(part.data)}`);
}

/** Render one provider's usage as terse parts, omitting any zero count. Empty ⇒ nothing to show. */
function formatUsageParts(u: Usage): string[] {
  const parts: string[] = [];
  if (u.inputTokens         > 0) parts.push(`↑${u.inputTokens}`);
  if (u.outputTokens        > 0) parts.push(`↓${u.outputTokens}`);
  if ((u.cacheReadTokens     ?? 0) > 0) parts.push(`${u.cacheReadTokens} cached`);
  if ((u.cacheCreationTokens ?? 0) > 0) parts.push(`+${u.cacheCreationTokens} written`);
  return parts;
}

/** Submit one turn and draw it to the terminal as it streams; the session it settled on. */
export async function runTurn(
  session:      Session,
  content:      string | UserContent[],
  run:          SessionRunner,
  providerName: string,
  principal:    Principal,
  promptFn:     PromptFn | undefined,
): Promise<Session> {
  const ac       = new AbortController();
  // Ctrl-C aborts the running turn (and drops anything queued) through the runner.
  const onSigint = (): void => { run.abort(session.id); };
  process.once('SIGINT', onSigint);

  const contentArr: UserContent[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;

  let updated       = session;
  let thinkingTicks = 0;
  let turnTraceId: string | undefined;

  const clearThinking = (): void => {
    if (thinkingTicks > 0) { process.stderr.write('\n'); thinkingTicks = 0; }
  };

  try {
    // The runner appends + persists the user message and auto-titles at turn start.
    const view = await run.open({
      sessionId: session.id,
      signal:    ac.signal,
      content:   contentArr,
      provider:  providerName,
      principal,
      ...(promptFn !== undefined ? { prompt: promptFn } : {}),
    });
    turnTraceId = view.traceId;
    for await (const ev of view.events) {
      if (ev.type === 'idle') continue; // session-level lifecycle signal, not this turn's
      if (ev.traceId !== view.traceId) continue;
      switch (ev.type) {
        case 'text-delta':
          clearThinking();
          // Per delta rather than one span opened at the turn's start: tool output interleaves, and
          // each of those ends with a reset that would otherwise drop the assistant back to default.
          process.stdout.write(cyanOut(ev.delta));
          break;
        case 'thinking':
          thinkingTicks++;
          write(`\r[thinking… ×${thinkingTicks}]`);
          break;
        case 'tool:start':
          clearThinking();
          write(`\n⚙  ${ev.name} ${JSON.stringify(ev.input)}\n`);
          break;
        case 'tool:stdout': write(ev.chunk); break;
        case 'tool:stderr': write(ev.chunk); break;
        case 'tool:progress': write(`\r[${ev.pct}%]${ev.message ? ' ' + ev.message : ''}`); break;
        case 'progress':      write(`\r[${ev.message ?? 'preparing'} ${ev.pct}%]`); break;
        case 'tool:end':    write(`\n`); break;
        case 'done':        clearThinking(); updated = ev.session; break;
        case 'robo-user': {
          // Machine-authored context folded onto the user turn by a screen hook (e.g. a fired
          // `contextual` trigger) — system-supplied, not the user's words, so label it as such.
          const text = ev.content
            .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
            .map(c => c.text).join('');
          if (text) { write(`[context] ${text}\n`); process.stderr.write(cyanErr('assistant: ')); }
          break;
        }
        case 'aborted': {
          clearThinking();
          updated = ev.session;
          const formMsg = [...ev.session.messages].reverse().find(
            m => m.content.some(c => c.type === 'form'),
          );
          if (formMsg) {
            const formPart = formMsg.content.find(
              (c): c is Extract<MessageContent, { type: 'form' }> => c.type === 'form',
            );
            if (formPart) {
              write('\n');
              const values: Record<string, string> = {};
              for (const field of formPart.fields) {
                // The FIELD, not a label + a hand-built hint: passing a synthesised string took the
                // free-text branch of the prompt, so a form's select answer came back as whatever was
                // typed — unresolved, and never the option's value. One resolver, every path.
                // With nobody to ask (a background job), each field takes its own default.
                values[field.name] = promptFn !== undefined ? await promptFn(field) : String(field.default ?? '');
              }
              process.removeListener('SIGINT', onSigint);
              ac.abort();
              return await runTurn(ev.session, [{ type: 'form-response', values }], run, providerName, principal, promptFn);
            }
          } else {
            process.stderr.write(yellow(`\n[aborted: ${ev.reason}]\n`));
          }
          break;
        }
        case 'marker': {
          clearThinking();
          for (const part of ev.content) {
            if (part.type === 'marker') write(`\n${formatMarker(part)}\n`);
          }
          break;
        }
        case 'error': clearThinking(); process.stderr.write(yellow(`\n[error: ${ev.error}]\n`)); break;
        default: break;
      }
      // One submission == one turn here; the per-session stream would otherwise keep yielding.
      if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    ac.abort();
  }

  write('\n');
  // Per-provider token accounting for this turn, from the persisted session (so it includes spend by
  // tools that ran their own completions — single_turn, ask_inner_voice, dream_time), eliding zero counts.
  const turnUsage = usageByProvider(updated.messages.filter(m => m.traceId === turnTraceId));
  const lines = [...turnUsage]
    .map(([prov, u]) => ({ prov, parts: formatUsageParts(u) }))
    .filter(e => e.parts.length > 0);
  if (lines.length === 1 && lines[0] !== undefined) {
    write(`[tokens · ${lines[0].prov}] ${lines[0].parts.join(' ')}\n`);
  } else if (lines.length > 1) {
    write('[tokens]\n');
    for (const e of lines) write(`  ${e.prov}: ${e.parts.join(' ')}\n`);
  }

  return updated;
}
