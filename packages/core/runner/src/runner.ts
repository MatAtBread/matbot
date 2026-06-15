import type {
  Session, Message, MessageContent,
  PipelineEvent, RunConfig, ProviderAdapter, ProviderConfig,
  Tool, ToolContext, Store, FileStore, SystemContextRegistry, Vault, PromptFn, FormField,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
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
  vault?:         Vault;
  workdir?:       string;
  configPath?:    string;
  files?:         FileStore;
  /** Supply a prompt implementation to allow tools to ask interactive questions. */
  prompt?:        PromptFn;
  loadPlugin:     (specifier: string, prompt?: PromptFn) => Promise<MatbotPlugin>;
  unloadPlugin:   (specifier: string) => Promise<boolean>;
}

export async function* runSession(opts: RunSessionOpts): AsyncIterable<PipelineEvent> {
  const { config, provider, providerConfig, store, signal } = opts;
  const tools   = opts.tools   ?? new Map<string, Tool>();
  const hookReg = opts.hooks   ?? new HookRegistry();
  const promptFn: PromptFn = opts.prompt ?? (((p: string | FormField, def?: string): Promise<string> => {
    const fallback = typeof p === 'string' ? def : p.default;
    if (fallback !== undefined) return Promise.resolve(fallback);
    const label = typeof p === 'string' ? p : p.label;
    return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${label}"`));
  }) as PromptFn);
  const vault: Vault = opts.vault ?? {
    async createSecret() { throw new Error('No vault configured'); },
    async writeSecret()  { throw new Error('No vault configured'); },
    hasKey() { return false; },
    async resolve(ref: string) { return ref; },
    scrub(text: string) { return text; },
  };
  const traceId = config.traceId ?? crypto.randomUUID();

  // ── 1. screen — once per turn: shape/abort the incoming submission ──────────

  const screen = await hookReg.runScreen({ session: opts.session, config, signal });
  // Hook-failure (and any other screen-injected) markers, carried live so the UI shows them this turn
  // rather than only on a later session reload. They are already persisted in screen.session.
  if (screen.markers.length > 0) {
    yield { type: 'marker', content: screen.markers, traceId };
  }
  if (screen.abort) {
    await store.set(screen.session.id, screen.session);
    yield { type: 'aborted', reason: screen.abort, session: screen.session, traceId };
    return;
  }
  let session = screen.session;

  // Turn-scoped ephemeral context from screen — prepended to every provider call this turn as a
  // system block, never persisted. (Lands in the cached prefix; constant within the turn.)
  const ephemeralMsg: Message[] = screen.ephemeral.length > 0
    ? [createMessage({ role: 'system', content: screen.ephemeral, traceId: '' })]
    : [];

  // ── 2. System context (built once per submit, never persisted) ─────────────

  const systemText = opts.systemContext
    ? await opts.systemContext.build({ session, signal })
    : null;

  const systemMsg = systemText !== null
    ? [createMessage({ role: 'system', content: [{ type: 'text', text: systemText }], traceId: '' })]
    : [];

  if (systemText !== null) {
    yield { type: 'system-context', text: systemText, traceId };
  }

  // ── 3. Agentic loop ────────────────────────────────────────────────────────

  for (;;) {
    // Respect an abort that arrived between turns (e.g. during tool execution).
    if (signal.aborted) {
      await store.set(session.id, session);
      yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
      return;
    }

    const pendingCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const assistantParts: MessageContent[] = [];
    let textAcc = '';

    // One provider call. The outgoing array (system context + screen's ephemeral block + history)
    // is assembled here and handed to `contribute` hooks for a final ephemeral transform — none of
    // this is written back to the session.
    const outgoing = await hookReg.runContribute({
      outgoing: [...systemMsg, ...ephemeralMsg, ...session.messages],
      session, config, signal,
    });
    try {
      for await (const ev of provider.complete(outgoing, providerConfig, [...tools.values()], signal)) {
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
    } catch (e: any) {
      if (signal.aborted) {
        // Save whatever the LLM streamed before the abort hit.
        if (textAcc) assistantParts.push({ type: 'text', text: textAcc });
        if (assistantParts.length > 0) {
          session = appendMessage(session, createMessage({
            role: 'assistant', content: assistantParts, traceId, providerName: config.provider,
          }));
        }
        await store.set(session.id, session);
        yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
        return;
      }
      yield { type: 'error', error: String(e) + (('cause' in e && e.cause) ? ' ('+String(e.cause)+')' : '' ), traceId };
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

    // No tool calls → done
    if (pendingCalls.length === 0) break;

    // ── 3. Execute tool calls ────────────────────────────────────────────────

    const toolResults: MessageContent[] = [];

    for (const tc of pendingCalls) {
      yield { type: 'tool:start', callId: tc.id, name: tc.name, input: tc.input, traceId };

      const tool = tools.get(tc.name);
      if (!tool) {
        const err = { error: `Unknown tool: ${tc.name}` };
        toolResults.push({ type: 'tool-result', id: tc.id, result: err, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: err, isError: true, traceId };
        continue;
      }

      const decision = await hookReg.runToolCall({
        session, config, signal,
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool,
      });
      if (decision.abort) {
        yield { type: 'aborted', reason: decision.abort, session, traceId };
        return;
      }
      if (decision.rejectTool) {
        const err = { error: decision.rejectTool.message };
        toolResults.push({ type: 'tool-result', id: tc.id, result: err, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: err, isError: true, traceId };
        continue;
      }

      let result: unknown;
      let isError = false;
      const startedAt = Date.now();

      const toolCtx: ToolContext = {
        callId: tc.id, session, signal, vault,
        provider:     config.provider,
        prompt:       promptFn,
        loadPlugin:   (specifier: string) => opts.loadPlugin(specifier, promptFn),
        unloadPlugin: opts.unloadPlugin,
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

      // toolresult — last chance to transform the result before it's recorded/yielded (hard redaction),
      // or to observe it (auditing: args + result + timing). Owns the LLM-facing + persisted surfaces.
      result = await hookReg.runToolResult({
        session, config, signal,
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool, result, isError, durationMs: Date.now() - startedAt,
      });

      toolResults.push({ type: 'tool-result', id: tc.id, result, isError });
      yield { type: 'tool:end', callId: tc.id, result, isError, traceId };
    }

    // Add tool results message, then loop for the next provider call.
    const toolMsg = createMessage({ role: 'tool', content: toolResults, traceId });
    session = appendMessage(session, toolMsg);
  }

  // ── 4. Persist and finish ──────────────────────────────────────────────────
  // `react` fires post-commit, in pump (the queue owner) — not here.

  await store.set(session.id, session);

  yield { type: 'done', session, traceId };
}
