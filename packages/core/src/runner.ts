import type {
  Session, MessageContent, InboundMessage,
  PipelineEvent, RunConfig, ProviderAdapter, ProviderConfig,
  Tool, ToolContext, Store,
} from './types.js';
import { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';

export interface RunSessionOpts {
  inbound:        InboundMessage;
  session:        Session;
  config:         RunConfig;
  provider:       ProviderAdapter;
  providerConfig: ProviderConfig;
  tools?:         ReadonlyMap<string, Tool>;
  store:          Store<Session>;
  hooks?:         HookRegistry;
  signal:         AbortSignal;
  workdir?:       string;
  /** Supply a prompt implementation to allow tools to ask interactive questions. */
  prompt?:        (question: string, defaultValue?: string) => Promise<string>;
  loadPlugin:     (specifier: string) => Promise<void>;
}

export async function* runSession(opts: RunSessionOpts): AsyncIterable<PipelineEvent> {
  const { inbound, config, provider, providerConfig, store, signal } = opts;
  const tools   = opts.tools   ?? new Map<string, Tool>();
  const hookReg = opts.hooks   ?? new HookRegistry();
  const promptFn = opts.prompt ?? ((q: string, def?: string) => {
    if (def !== undefined) return Promise.resolve(def);
    return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${q}"`));
  });
  const traceId = config.traceId ?? crypto.randomUUID();

  // ── 1. Append inbound user message ─────────────────────────────────────────

  const contentArr: MessageContent[] = Array.isArray(inbound.content)
    ? inbound.content
    : [{ type: 'text', text: inbound.content }];

  const userMsg = createMessage({
    role:    'user',
    content: contentArr,
    traceId,
  });

  let session = appendMessage(opts.session, userMsg);

  // Auto-title the session from the first user message if not already named
  if (!opts.session.title && !opts.session.messages.some(m => m.role === 'user')) {
    const text = Array.isArray(inbound.content)
      ? contentArr.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
          .map(c => c.text).join(' ').trim()
      : inbound.content.trim();
    if (text) {
      const words = text.split(/\s+/).slice(0, 8).join(' ');
      session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
    }
  }

  yield { type: 'submit:start', message: userMsg, traceId };

  // ── 2. before:submit hooks ─────────────────────────────────────────────────

  let ctx = await hookReg.run('before:submit', {
    session, principal: config.principal, config, signal,
  });

  if (ctx.abort) {
    const abortedSession = ctx.session as Session;
    await store.set(abortedSession.id, abortedSession);
    yield { type: 'aborted', reason: ctx.abort, session: abortedSession, traceId };
    return;
  }

  session = ctx.session as Session;

  if (ctx.inject) {
    yield { type: 'robo-user', content: ctx.inject, traceId };
  }

  // ── 3. Agentic loop ────────────────────────────────────────────────────────

  const toolList = [...tools.values()];

  for (;;) {
    const pendingCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const assistantParts: MessageContent[] = [];
    let textAcc = '';

    // One provider call
    try {
      for await (const ev of provider.complete(session.messages, providerConfig, toolList, signal)) {
        switch (ev.type) {
          case 'text-delta':
            textAcc += ev.delta;
            yield { type: 'text-delta', delta: ev.delta, traceId };
            break;
          case 'thinking':
            yield { type: 'thinking', delta: ev.delta, traceId };
            break;
          case 'thinking-block':
            assistantParts.push({ type: 'thinking', thinking: ev.thinking, signature: ev.signature });
            break;
          case 'redacted-thinking':
            assistantParts.push({ type: 'redacted-thinking', data: ev.data });
            break;
          case 'reasoning-block':
            assistantParts.push({ type: 'reasoning', reasoning: ev.reasoning });
            break;
          case 'tool-call':
            pendingCalls.push({ id: ev.id, name: ev.name, input: ev.input });
            break;
          case 'usage':
            yield { type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, traceId,
              ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}) };
            break;
          case 'done':
            break;
        }
      }
    } catch (e) {
      yield { type: 'error', error: String(e), traceId };
      return;
    }

    // Build and store assistant message
    if (textAcc)           assistantParts.push({ type: 'text', text: textAcc });
    for (const tc of pendingCalls) {
      assistantParts.push({ type: 'tool-call', id: tc.id, name: tc.name, input: tc.input });
    }

    if (assistantParts.length > 0) {
      const assistantMsg = createMessage({
        role:         'assistant',
        content:      assistantParts,
        traceId,
        providerName: config.provider,
      });
      session = appendMessage(session, assistantMsg);
    }

    const afterRespCtx = await hookReg.run('after:response', {
      session, principal: config.principal, config, signal,
    });
    if (afterRespCtx.abort) {
      yield { type: 'aborted', reason: afterRespCtx.abort, session: afterRespCtx.session as Session, traceId };
      return;
    }
    session = afterRespCtx.session as Session;

    if (afterRespCtx.inject) {
      yield { type: 'robo-user', content: afterRespCtx.inject, traceId };
    }

    // No tool calls → done
    if (pendingCalls.length === 0) break;

    // ── 4. Execute tool calls ────────────────────────────────────────────────

    const toolResults: MessageContent[] = [];

    for (const tc of pendingCalls) {
      yield { type: 'tool:start', callId: tc.id, name: tc.name, input: tc.input, traceId };

      const toolCtxPre = await hookReg.run('before:tool', {
        session, principal: config.principal, config, signal,
      });
      if (toolCtxPre.abort) {
        yield { type: 'aborted', reason: toolCtxPre.abort, session: toolCtxPre.session as Session, traceId };
        return;
      }
      session = toolCtxPre.session as Session;

      const tool = tools.get(tc.name);
      if (!tool) {
        const err = { error: `Unknown tool: ${tc.name}` };
        toolResults.push({ type: 'tool-result', id: tc.id, result: err, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: err, traceId };
        continue;
      }

      // Capability check
      if (!checkGrants(tool, config)) {
        const err = { error: `Capability denied for tool "${tc.name}"` };
        toolResults.push({ type: 'tool-result', id: tc.id, result: err, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: err, traceId };
        continue;
      }

      let result: unknown;
      let isError = false;

      const toolCtx: ToolContext = {
        callId: tc.id, session, principal: config.principal, signal,
        prompt: promptFn,
        loadPlugin: opts.loadPlugin,
        ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
      };

      try {
        for await (const toolEv of tool.executor.execute(tc.input, toolCtx)) {
          switch (toolEv.type) {
            case 'stdout':   yield { type: 'tool:stdout', callId: tc.id, chunk: toolEv.chunk, traceId }; break;
            case 'stderr':   yield { type: 'tool:stderr', callId: tc.id, chunk: toolEv.chunk, traceId }; break;
            case 'file':     yield { type: 'file', handle: toolEv.handle, traceId }; break;
            case 'result':   result = toolEv.value; break;
            case 'progress': break;
            case 'error':    result = {
              error: toolEv.message,
              ...(toolEv.stdout !== undefined ? { stdout: toolEv.stdout } : {}),
              ...(toolEv.stderr !== undefined ? { stderr: toolEv.stderr } : {}),
            }; isError = true; break;
          }
        }
      } catch (e) {
        result  = { error: String(e) };
        isError = true;
      }

      const toolCtxPost = await hookReg.run('after:tool', {
        session, principal: config.principal, config, signal,
      });
      session = toolCtxPost.session as Session;

      toolResults.push({ type: 'tool-result', id: tc.id, result, isError });
      yield { type: 'tool:end', callId: tc.id, result, traceId };
    }

    // Add tool results message, run before:response hooks, then loop
    const toolMsg = createMessage({ role: 'tool', content: toolResults, traceId });
    session = appendMessage(session, toolMsg);

    ctx = await hookReg.run('before:response', {
      session, principal: config.principal, config, signal,
    });
    if (ctx.abort) {
      yield { type: 'aborted', reason: ctx.abort, session: ctx.session as Session, traceId };
      return;
    }
    session = ctx.session as Session;
  }

  // ── 5. Persist and finish ──────────────────────────────────────────────────

  await store.set(session.id, session);

  await hookReg.run('after:submit', {
    session, principal: config.principal, config, signal,
  });

  yield { type: 'done', session, traceId };
}

function checkGrants(tool: Tool, config: RunConfig): boolean {
  if (!tool.requires || tool.requires.length === 0) return true;
  return tool.requires.every(cap =>
    config.principal.grants.some(g => g.capability === cap),
  );
}
