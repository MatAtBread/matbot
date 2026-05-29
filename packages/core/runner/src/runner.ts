import type {
  Session, MessageContent,
  PipelineEvent, RunConfig, ProviderAdapter, ProviderConfig,
  Tool, ToolContext, Store, FileStore, SystemContextRegistry,
} from './types.js';
import { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';

export interface RunSessionOpts {
  session:        Session;
  config:         RunConfig;
  provider:       ProviderAdapter;
  providerConfig: ProviderConfig;
  tools?:         ReadonlyMap<string, Tool>;
  store:          Store<Session>;
  hooks?:         HookRegistry;
  systemContext?: SystemContextRegistry;
  signal:         AbortSignal;
  workdir?:       string;
  configPath?:    string;
  files?:         FileStore;
  /** Supply a prompt implementation to allow tools to ask interactive questions. */
  prompt?:        (question: string, defaultValue?: string) => Promise<string>;
  loadPlugin:     (specifier: string) => Promise<void>;
}

export async function* runSession(opts: RunSessionOpts): AsyncIterable<PipelineEvent> {
  const { config, provider, providerConfig, store, signal } = opts;
  const tools   = opts.tools   ?? new Map<string, Tool>();
  const hookReg = opts.hooks   ?? new HookRegistry();
  const promptFn = opts.prompt ?? ((q: string, def?: string) => {
    if (def !== undefined) return Promise.resolve(def);
    return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${q}"`));
  });
  const traceId = config.traceId ?? crypto.randomUUID();

  // ── 1. before:submit hooks ─────────────────────────────────────────────────

  let session = opts.session;

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

  // ── 2. System context (built once per submit, never persisted) ─────────────

  const systemText = opts.systemContext
    ? await opts.systemContext.build({ session, principal: config.principal, signal })
    : null;

  const systemMsg = systemText !== null
    ? [createMessage({ role: 'system', content: [{ type: 'text', text: systemText }], traceId: '' })]
    : [];

  // ── 3. Agentic loop ────────────────────────────────────────────────────────

  const toolList = [...tools.values()];

  for (;;) {
    // Respect an abort that arrived between turns (e.g. during tool execution).
    if (signal.aborted) {
      await store.set(session.id, session);
      yield { type: 'aborted', reason: 'user-abort', session, traceId };
      return;
    }

    const pendingCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const assistantParts: MessageContent[] = [];
    let textAcc = '';

    // One provider call — system context prepended here, never written back to session
    try {
      for await (const ev of provider.complete([...systemMsg, ...session.messages], providerConfig, toolList, signal)) {
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
          case 'unknown-block':
            assistantParts.push({ type: 'unknown-content', blockType: ev.blockType, raw: ev.raw });
            break;
          case 'reasoning-block':
            assistantParts.push({ type: 'reasoning', reasoning: ev.reasoning });
            break;
          case 'tool-call':
            pendingCalls.push({ id: ev.id, name: ev.name, input: ev.input });
            break;
          case 'usage':
            yield { type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, traceId,
              ...(ev.costUsd              !== undefined ? { costUsd:              ev.costUsd              } : {}),
              ...(ev.cacheReadTokens     !== undefined ? { cacheReadTokens:     ev.cacheReadTokens     } : {}),
              ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}) };
            break;
          case 'done':
            break;
        }
      }
    } catch (e) {
      if (signal.aborted) {
        // Save whatever the LLM streamed before the abort hit.
        if (textAcc) assistantParts.push({ type: 'text', text: textAcc });
        if (assistantParts.length > 0) {
          session = appendMessage(session, createMessage({
            role: 'assistant', content: assistantParts, traceId, providerName: config.provider,
          }));
        }
        await store.set(session.id, session);
        yield { type: 'aborted', reason: 'user-abort', session, traceId };
        return;
      }
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

    // ── 3. Execute tool calls ────────────────────────────────────────────────

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
        ...(opts.workdir     !== undefined ? { workdir:     opts.workdir     } : {}),
        ...(opts.configPath  !== undefined ? { configPath:  opts.configPath  } : {}),
        ...(opts.files       !== undefined ? { files:       opts.files       } : {}),
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

  // ── 4. Persist and finish ──────────────────────────────────────────────────

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
