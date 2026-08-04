import type {
  Session, Message, MessageContent, ModelContent, Usage, ProviderMeta, DeferredCorrection, TruncatedToolResult,
  PipelineEvent, RunConfig, ProviderAdapter, ProviderConfig,
  Tool, ToolRegistry, ToolContext, Store, FileStore, SystemContextRegistry, Vault, PromptFn, FormField,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { ToolPresenter } from '@matatbread/matbot-plugin-api';
import { currentUsageSink } from '@matatbread/matbot-plugin-api';
import { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';
import { addUsage } from './usage.js';

// Substituted for an errored tool result when the turn was aborted (e.g. a mid-turn steer interrupt):
// the tool was cut off, not genuinely faulty, and the raw abort reason ("Error: steer") is a leaked
// internal token that reads as a real failure. A steer's continuation turn is the one place a model
// reads this, so the wording tells it the call was interrupted and leaves re-running to its judgement —
// deliberately NOT "re-run it", so a side-effecting tool isn't reflexively repeated.
// Creator of the marker recording that a provider cut a response short. Marker-role, so it is durable
// and visible to a reader while elided from every submission: the model's own text is already truncated
// in the transcript, and a block telling it so invites narrating the cut-off rather than continuing.
const TRUNCATION_CREATOR = 'matbot-truncation';

const INTERRUPTED_TOOL_RESULT = {
  error: 'Tool call interrupted before completion — the turn was interrupted while it was running. It may not have run to completion, and any side effect may or may not have occurred. Re-run it only if you still need its result.',
} as const;

export interface RunSessionOpts {
  session:        Session;
  config:         RunConfig;
  provider:       ProviderAdapter;
  providerConfig: ProviderConfig;
  tools?:         ReadonlyMap<string, Tool>;
  /**
   * Live registry consulted to *resolve the executor* at call time. The `tools` map above is a
   * turn-start snapshot — the stable menu advertised to the model for the whole turn — but a tool
   * that mutates the registry mid-turn (`plugin reload`/`add`/`remove`) must take effect for any
   * call later in the *same* turn, so execution resolves against this live registry rather than the
   * snapshot. Present ⇒ authoritative (a tool removed mid-turn resolves to null ⇒ "Unknown tool",
   * which is correct); absent ⇒ falls back to the snapshot (direct callers / tests that pass only
   * `tools`).
   */
  toolRegistry?:  ToolRegistry;
  /**
   * Optional presenter that picks which tools are advertised to the model on each provider call — a
   * read-only view over the `tools` snapshot (e.g. deferring a large library behind a search tool and
   * revealing matches mid-turn). Consulted *per provider call* so a reveal takes effect on the next
   * loop iteration; absent ⇒ the whole snapshot is advertised (unchanged behaviour). Presentation never
   * affects execution — a withheld tool still resolves by name through `toolRegistry`.
   */
  toolPresenter?: ToolPresenter;
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
  /**
   * Turn-scoped context to inject ephemerally, exactly like a `screen` hook's `ephemeral` (tail-folded
   * onto the freshest non-marker message, never persisted) — merged ahead of whatever `screen` adds.
   * The pump supplies this for an agent-phase retract-redo: the trigger tool's output rides into the
   * re-run of the originating user turn. Empty/absent for an ordinary turn.
   */
  injectedEphemeral?: MessageContent[];
  loadPlugin:     (specifier: string, prompt?: PromptFn, refresh?: boolean) => Promise<MatbotPlugin>;
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

  const screen = await hookReg.runScreen({ session: opts.session, config, signal, prompt: promptFn });
  if (screen.abort) {
    // Hook-failure (and any other screen-injected) markers carried live, even on abort, so a
    // misconfigured hook surfaces this turn rather than only on a later reload.
    if (screen.markers.length > 0) yield { type: 'marker', content: screen.markers, traceId };
    await store.set(screen.session.id, screen.session);
    yield { type: 'aborted', reason: screen.abort, session: screen.session, traceId };
    return;
  }
  // Durable context a screen hook folded onto the user message (e.g. a fired `contextual` trigger),
  // carried live so a frontend draws it now rather than only on a later reload. It is already part of
  // screen.session (origin: 'robo' blocks on the user turn) — this event is purely live delivery.
  // Emitted BEFORE the markers so the live order matches a reload: the durable blocks belong to the
  // user message (rendered with the turn), while screen markers were appended to the session AFTER it.
  if (screen.durable.length > 0) {
    yield { type: 'robo-user', content: screen.durable, traceId };
  }
  // Hook-failure (and any other screen-injected) markers, carried live so the UI shows them this turn
  // rather than only on a later session reload. They are already persisted in screen.session.
  if (screen.markers.length > 0) {
    yield { type: 'marker', content: screen.markers, traceId };
  }
  let session = screen.session;

  // Turn-scoped ephemeral context from screen — appended to the TAIL of the outgoing messages
  // (onto the content of the freshest history message, preserving its role), never persisted.
  // At the tail, not as a system prefix, because (a) a "do X now" directive needs the salience of
  // being the last thing the model reads — a system-block prefix sits above the whole history and
  // reads as stale once the turn has any momentum — and (b) per-turn content in the prefix would
  // bust the cached system/history prefix every turn; appended at the tail it leaves the prefix
  // byte-stable. Folding into the last message (rather than adding a trailing message) avoids
  // role-alternation hazards and survives both adapters (Anthropic folds system→system=; OpenAI
  // drops non-result content from tool-role messages — a separate trailing message would break on
  // one or the other).
  // injectedEphemeral (a pump-supplied retract-redo's context) leads, then screen's own — both share
  // the identical tail-fold path below. Mutable: a raced screen verdict (below) folds its correction
  // in here when it fires, and the loop re-runs with it.
  let ephemeral = [...(opts.injectedEphemeral ?? []), ...screen.ephemeral];

  // Raced screen verdicts (see DeferredScreen): polled — synchronously, never awaited — at each loop
  // edge. `pollDeferred` claims any that have fired this poll (exactly once each) and merges their
  // corrections; `applyCorrection` then folds them in and returns any durable blocks to emit live.
  const deferred = screen.deferred;
  const pollDeferred = (): DeferredCorrection | undefined => {
    if (deferred.length === 0) return undefined;
    const ephemeralC: MessageContent[] = [];
    const durableC:   MessageContent[] = [];
    for (const d of deferred) {
      const c = d.claim();
      if (!c) continue;
      if (c.ephemeral) ephemeralC.push(...c.ephemeral);
      if (c.durable)   durableC.push(...c.durable);
    }
    return (ephemeralC.length > 0 || durableC.length > 0) ? { ephemeral: ephemeralC, durable: durableC } : undefined;
  };
  // Apply a claimed correction: `ephemeral` leads the tail-fold for the re-run; `durable` is folded onto
  // the turn's user message (persisted, re-run sees it in history) and RETURNED so the caller emits it
  // live as a `robo-user` event — the durable twin, preserving a contextual fire's persistence even
  // though the verdict landed mid-turn. Mutates `ephemeral`/`session` in place.
  const applyCorrection = (c: DeferredCorrection): MessageContent[] => {
    if (c.ephemeral && c.ephemeral.length > 0) ephemeral = [...c.ephemeral, ...ephemeral];
    if (c.durable && c.durable.length > 0) {
      const idx = session.messages.findLastIndex(m => m.role === 'user');
      if (idx >= 0) {
        session = { ...session, messages: session.messages.map((m, i) =>
          i === idx ? { ...m, content: [...m.content, ...c.durable!] } : m) };
        return c.durable;
      }
    }
    return [];
  };

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

  // Rounds already run against this provider, where a round is one provider call plus the tool batch it
  // asked for. Compared against the provider profile's own `maxRounds` — a spend ceiling denominated in
  // the unit spend varies by. Absent ⇒ unbounded (`?? Infinity`), the historical behaviour.
  let round = 0;

  // Tool-supplied media, keyed by the tool message it answers — see the `model-content` ToolEvent.
  // Turn-scoped and wire-only: it is spliced into the outgoing copy below and dies with this call.
  const attachments = new Map<string, Message>();

  for (;;) {
    // Respect an abort that arrived between turns (e.g. during tool execution).
    if (signal.aborted) {
      await store.set(session.id, session);
      yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
      return;
    }

    // Checked HERE — before starting a round, not part-way through one — so the previous round's tool
    // results are already appended and there is nothing to reconcile: the same persist-and-yield as the
    // abort above. A turn stopped by the ceiling was cut short, not faulty, so it ends `aborted` rather
    // than `error`, and the reason is machine-readable for a frontend that wants to say why.
    if (round >= (providerConfig.maxRounds ?? Infinity)) {
      await store.set(session.id, session);
      yield { type: 'aborted', reason: `round-limit: provider "${config.provider}" allows ${providerConfig.maxRounds} rounds per turn`, session, traceId };
      return;
    }
    round += 1;

    // A raced screen verdict that already fired (settled during setup, or while a previous tool round
    // ran): fold its correction in before generating, so this call is informed directly rather than
    // discarded. This is the no-waste path — the verdict landed before we spent any tokens.
    const early = pollDeferred();
    if (early) { const dur = applyCorrection(early); if (dur.length > 0) yield { type: 'robo-user', content: dur, traceId }; }

    const pendingCalls: Array<{ id: string; name: string; input: unknown; meta?: ProviderMeta;
      truncated?: { bytes: number; stopReason?: string } }> = [];
    const assistantParts: MessageContent[] = [];
    let textAcc = '';
    let turnUsage: Usage | undefined;
    let truncation: { reason: 'max-tokens' | 'stream-end'; raw?: string } | undefined;
    // Set if a raced verdict fires mid-generation: discard this response and re-run the loop (below).
    let restart = false;

    // One provider call. The outgoing array (system context + history, with screen's ephemeral
    // blocks appended onto the tail message) is assembled here and handed to `contribute` hooks for
    // a final ephemeral transform — none of this is written back to the session.
    // Fold onto the last NON-marker message: markers are elided from the wire, so the literal last
    // message can be a marker (e.g. a retract-redo leaves the retraction marker as the tail) — folding
    // there would drop the ephemeral with it. -1 ⇒ nothing to fold onto (no non-marker history).
    const foldIdx = ephemeral.length > 0 ? session.messages.findLastIndex(m => m.role !== 'marker') : -1;
    const history = foldIdx >= 0 || attachments.size > 0
      ? session.messages.flatMap((m, i) => {
          const folded = i === foldIdx ? { ...m, content: [...m.content, ...ephemeral] } : m;
          const media  = attachments.get(m.id);
          return media ? [folded, media] : [folded];
        })
      : session.messages;
    const outgoing = await hookReg.runContribute({
      outgoing: [...systemMsg, ...history],
      session, config, signal,
    });
    // Tools advertised for THIS call. A presenter (optional) may present a subset of the snapshot and
    // grow it across iterations as the model discovers tools; absent ⇒ the whole snapshot. Withheld
    // tools stay callable — execution resolves against the live registry (opts.toolRegistry), not this.
    const advertised = opts.toolPresenter
      ? await opts.toolPresenter.present([...tools.values()], { session, provider: config.provider })
      : [...tools.values()];
    // Per-call signal linked to the turn signal: an in-situ restart aborts THIS provider call (callAc)
    // to cancel the in-flight request and stop backend generation, without aborting the whole turn.
    const callAc = new AbortController();
    const callSignal = AbortSignal.any([signal, callAc.signal]);
    try {
      for await (const ev of provider.complete(outgoing, providerConfig, advertised, callSignal)) {
        // A raced verdict firing mid-generation changes the premise: discard this doomed response and
        // restart the loop with the correction folded in. Polled BEFORE the event is emitted, so a
        // classifier faster than time-to-first-token is caught before any token reaches the frontend.
        const hit = pollDeferred();
        if (hit) {
          const dur = applyCorrection(hit);
          if (dur.length > 0) yield { type: 'robo-user', content: dur, traceId };
          restart = true; callAc.abort('screen-restart'); break;
        }
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
            pendingCalls.push({ id: ev.id, name: ev.name, input: ev.input,
              ...(ev.meta      !== undefined ? { meta:      ev.meta      } : {}),
              ...(ev.truncated !== undefined ? { truncated: ev.truncated } : {}) });
            break;
          case 'truncated':
            truncation = { reason: ev.reason, ...(ev.raw !== undefined ? { raw: ev.raw } : {}) };
            break;
          case 'usage':
            turnUsage = addUsage(turnUsage, ev);
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
      // A provider call cancelled by an in-situ restart (callAc, not the turn signal) is expected — fall
      // through to the restart below rather than surfacing it as a turn abort or an error.
      if (restart || (callAc.signal.aborted && !signal.aborted)) {
        restart = true;
      } else if (signal.aborted) {
        // Save whatever the LLM streamed before the abort hit.
        if (textAcc) assistantParts.push({ type: 'text', text: textAcc });
        if (assistantParts.length > 0) {
          session = appendMessage(session, createMessage({
            role: 'assistant', content: assistantParts, traceId, providerName: config.provider,
            ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
          }));
        }
        await store.set(session.id, session);
        yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
        return;
      } else {
        yield { type: 'error', error: String(e) + (('cause' in e && e.cause) ? ' ('+String(e.cause)+')' : '' ), traceId };
        return;
      }
    }

    // In-situ restart: discard this iteration's (uncommitted) response and re-run the loop with the
    // raced correction now folded into `ephemeral`. No store write, no retraction marker — the clean
    // counterpart to a post-commit `followup` retract.
    if (restart) continue;

    // Pre-commit poll: the verdict may have settled exactly as the stream ended. Discard and re-run
    // rather than commit-then-retract, keeping the correction on the cheaper in-situ path.
    const late = pollDeferred();
    if (late) { const dur = applyCorrection(late); if (dur.length > 0) yield { type: 'robo-user', content: dur, traceId }; continue; }

    // Build and store assistant message
    if (textAcc)           assistantParts.push({ type: 'text', text: textAcc });
    for (const tc of pendingCalls) {
      assistantParts.push({ type: 'tool-call', id: tc.id, name: tc.name, input: tc.input,
        ...(tc.meta !== undefined ? { meta: tc.meta } : {}) });
    }

    if (assistantParts.length > 0) {
      const assistantMsg = createMessage({
        role:         'assistant',
        content:      assistantParts,
        traceId,
        providerName: config.provider,
        ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
      });
      session = appendMessage(session, assistantMsg);
    }

    // The provider cut this response short rather than the model choosing to stop. Recorded whether or
    // not a tool call was caught in it — the commoner case has none, and prose stopping mid-sentence
    // previously left no trace anywhere. What to DO about it (continue, re-ask with a bigger budget) is
    // a `followup` hook's call, not the harness's.
    if (truncation) {
      const marker: MessageContent = { type: 'marker', creator: TRUNCATION_CREATOR, data: truncation };
      session = appendMessage(session, createMessage({ role: 'marker', content: [marker], traceId }));
      yield { type: 'marker', content: [marker], traceId };
    }

    if (assistantParts.length === 0) {
      // Diagnostic: the provider returned no text, no tool calls, no thinking — a genuinely empty
      // completion. The turn will end with no assistant message, which reads as "the agent never
      // replied". Logged here so a silent no-reply turn is traceable. (textAcc length is shown to
      // tell a truly empty stream apart from one that was only whitespace.)
      console.warn(`[runner] empty completion (no assistant content) on traceId ${traceId}; textAcc=${textAcc.length} chars, provider=${config.provider}`);
    }

    // No tool calls → done
    if (pendingCalls.length === 0) break;

    // ── 3. Execute tool calls ────────────────────────────────────────────────

    const toolResults: MessageContent[] = [];
    const toolMarkers: MessageContent[] = [];
    const toolMedia:   ModelContent[]   = [];

    for (const [callIdx, tc] of pendingCalls.entries()) {
      yield { type: 'tool:start', callId: tc.id, name: tc.name, input: tc.input, traceId };

      const tool = opts.toolRegistry !== undefined ? opts.toolRegistry.resolve(tc.name) : tools.get(tc.name);
      if (!tool) {
        const err = { error: `Unknown tool: ${tc.name}` };
        toolResults.push({ type: 'tool-result', id: tc.id, result: err, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: err, isError: true, traceId };
        continue;
      }

      // Arguments severed mid-stream (the provider hit its token limit part-way through the call).
      // The call cannot run, but it must still be answered: the assistant message above carries a
      // `tool-call` block for it, and an unpaired `tool_use` is rejected by the next submission. So it
      // is recorded as a call that failed — no execution, no side effect — and the model reads the
      // failure in the slot it expects and retries smaller, which is the ordinary self-correction the
      // loop already does for a rejected or unknown tool. No retry counter: a model that keeps
      // overflowing burns rounds and meets `maxRounds`, exactly as one repeatedly calling any failing
      // tool does.
      //
      // `toolcall` is skipped — there is nothing to judge, the call cannot proceed whatever a hook
      // says — but `toolresult` runs, because it owns the LLM-facing text and is where a consumer
      // folds in advice the harness cannot have: which of THIS tool's parameters offers a cheaper
      // edit. See `isTruncatedToolResult`.
      if (tc.truncated) {
        const truncated: TruncatedToolResult = {
          error:
            `Arguments for "${tc.name}" were cut off after ${tc.truncated.bytes} bytes and could not be parsed` +
            `${tc.truncated.stopReason !== undefined ? ` (stop reason "${tc.truncated.stopReason}")` : ''}. ` +
            'The call did NOT run and had no effect. Retry it smaller — fewer operations in one call, ' +
            'or split the work across several calls.',
          truncated: { tool: tc.name, bytes: tc.truncated.bytes,
            ...(tc.truncated.stopReason !== undefined ? { stopReason: tc.truncated.stopReason } : {}) },
        };
        const shaped = await hookReg.runToolResult({
          session, config, signal,
          toolCall: { id: tc.id, name: tc.name, input: tc.input },
          tool, result: truncated, isError: true, durationMs: 0,
        });
        toolResults.push({ type: 'tool-result', id: tc.id, result: shaped, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: shaped, isError: true, traceId };
        continue;
      }

      const decision = await hookReg.runToolCall({
        session, config, signal,
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool,
      });
      if (decision.abort) {
        // Commit the turn before leaving. This was the one terminal path that returned without a
        // persist, and nothing is written mid-turn (see the store.set sites) — so a hook aborting on a
        // late round discarded the whole turn: every earlier round's assistant message and tool
        // results, plus this round's response, all of which the frontend had already drawn.
        //
        // Committing requires closing the tool_use/tool_result pairing first: the assistant message
        // above carries a `tool-call` block per pending call, and a `tool_use` left unpaired is
        // rejected by the next submission (Anthropic 400s; nothing downstream reconciles them). The
        // abort is a turn-level stop rather than a verdict on the tools, so the calls that never ran
        // are recorded as not-run. `tool:end` is carried only for the call the hook actually judged —
        // the rest never had a `tool:start`, so a frontend has no bubble to close for them.
        const stopped = { error: `Tool call not executed — the turn was aborted (${decision.abort}).` };
        toolResults.push({ type: 'tool-result', id: tc.id, result: stopped, isError: true });
        yield { type: 'tool:end', callId: tc.id, result: stopped, isError: true, traceId };
        for (const rest of pendingCalls.slice(callIdx + 1)) {
          toolResults.push({ type: 'tool-result', id: rest.id, result: stopped, isError: true });
        }
        session = appendMessage(session, createMessage({ role: 'tool', content: toolResults, traceId }));
        if (toolMarkers.length > 0) {
          session = appendMessage(session, createMessage({ role: 'marker', content: toolMarkers, traceId }));
          yield { type: 'marker', content: toolMarkers, traceId };
        }
        await store.set(session.id, session);
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
      // Token accounting for completions this tool runs (via singleTurn/complete) accrues into the
      // ambient turn sink; slice off whatever it appends during *this* call to attribute it here.
      const usageSink = currentUsageSink();
      const usageMark = usageSink?.length ?? 0;
      const startedAt = Date.now();

      const toolCtx: ToolContext = {
        callId: tc.id, session, signal, vault,
        provider:     config.provider,
        prompt:       promptFn,
        loadPlugin:   (specifier: string, refresh?: boolean) => opts.loadPlugin(specifier, promptFn, refresh),
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
            case 'marker':   toolMarkers.push({ type: 'marker', creator: toolEv.creator, data: toolEv.data }); break;
            case 'model-content': toolMedia.push(...toolEv.content); break;
            case 'progress': yield { type: 'tool:progress', callId: tc.id, pct: toolEv.pct, ...(toolEv.message !== undefined ? { message: toolEv.message } : {}), traceId }; break;
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

      // A tool that errored under an aborted signal did so because it was cut off (a steer interrupt,
      // a user cancel), not a genuine fault — reframe it before it is recorded, so the raw abort reason
      // never reaches the model or the transcript. Covers both the throw and the yielded-`error` paths;
      // a successful result is left untouched.
      if (signal.aborted && isError) {
        result = INTERRUPTED_TOOL_RESULT;
      }

      // toolresult — last chance to transform the result before it's recorded/yielded (hard redaction),
      // or to observe it (auditing: args + result + timing). Owns the LLM-facing + persisted surfaces.
      result = await hookReg.runToolResult({
        session, config, signal,
        toolCall: { id: tc.id, name: tc.name, input: tc.input },
        tool, result, isError, durationMs: Date.now() - startedAt,
      });

      const callUsage = usageSink ? usageSink.slice(usageMark) : [];
      toolResults.push({ type: 'tool-result', id: tc.id, result, isError,
        ...(callUsage.length > 0 ? { usage: callUsage } : {}) });
      yield { type: 'tool:end', callId: tc.id, result, isError, traceId };
    }

    // Add tool results message, then loop for the next provider call.
    const toolMsg = createMessage({ role: 'tool', content: toolResults, traceId });
    session = appendMessage(session, toolMsg);

    // Media the tools handed over for the model to look at. Held wire-side only — pinned directly
    // after the tool message it came from (so it keeps a stable history position, and so the model
    // reads it as the answer to that call) and spliced into `outgoing` on every remaining round of
    // this turn. Never appended to `session`: the transcript records what the tool returned, not the
    // bytes it showed.
    if (toolMedia.length > 0) {
      attachments.set(toolMsg.id, createMessage({ role: 'user', content: toolMedia, traceId }));
    }

    // Markers a tool emitted while running: persist as their own marker-role message (elided from
    // provider submission) and carry live so a frontend can render them without a reload.
    if (toolMarkers.length > 0) {
      session = appendMessage(session, createMessage({ role: 'marker', content: toolMarkers, traceId }));
      yield { type: 'marker', content: toolMarkers, traceId };
    }
  }

  // ── 4. Persist and finish ──────────────────────────────────────────────────
  // `react` fires post-commit, in pump (the queue owner) — not here.

  await store.set(session.id, session);

  yield { type: 'done', session, traceId };
}
