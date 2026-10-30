import type {
  Session, Message, MessageContent, Principal, PromptFn, PipelineEvent,
  Store, ToolRegistry, SystemContextRegistry, Vault, FileStore, MediaStore, UserContent, Tool,
  ProviderAdapter, ProviderConfig, SessionRunner, SessionView, OpenOpts, SubmitOpenOpts,
  SteeringPolicy, SteeringDecision, PermissionGate,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { HookRegistry } from './hooks.js';
import type { ToolTypeIndex, ToolPresenter, SessionAppender, SessionWrite } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from './session.js';
import { isReadOnlyError, foldOntoUserTurn, lastUserIndex, runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { machineBusy, withUsageScope } from '@matatbread/matbot-plugin-api/host';
import { runSession } from './runner.js';
import { ingestMedia } from './media.js';
import { MemoryStore } from './storage-base/memory-store.js';
import { createSink, emit, notify, aheadOf, type ParallelReply, type SessionState } from './session-state.js';
import {
  WRITE_ATTEMPTS, parallelFraming, closedSpan, flushUsage, drainMerges, drainWrites, interjectInto, rewrite, placeNow,
} from './session-merges.js';

export interface SessionRunnerDeps {
  store:           Store<Session>;
  resolveProvider: (name: string) => Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null>;
  tools?:          ToolRegistry;
  // Resolved live (the service registers after boot): supplies the per-tool wire contract derived from each
  // tool's single contract source (the `ToolContracts` arms, or a source-less tool's `toolContract`), folded
  // into the turn-start tool snapshot's description so the wire carries params/result text. Absent (e.g.
  // browser) ⇒ tools keep their plain description.
  toolTypeIndex?:  () => ToolTypeIndex | undefined;
  // Resolved live (registers after boot): picks which tools are advertised to the model per provider
  // call. Absent ⇒ the whole turn snapshot is advertised. Threaded into runSession per turn.
  toolPresenter?:  () => ToolPresenter | undefined;
  // Resolved live (registers after boot): decides how a mid-turn submission under `mode: 'auto'` is
  // disposed (queue vs interrupt) and supplies an interrupt's continuation nudge. Absent ⇒ the runner's
  // own defaults (DEFAULT_STEERING_POLICY / DEFAULT_STEER_NUDGE).
  steeringPolicy?: () => SteeringPolicy | undefined;
  // Resolved live (a host registers its boot default, a plugin may replace it): where a submission's
  // by-value media is written at the boundary, and where the runner reads it back from. Absent ⇒ an
  // attachment is refused with a reason and a stored `file-ref` degrades to the converters' text note.
  mediaStore?:     () => MediaStore | undefined;
  // Resolved live (the host boots a default, a plugin may replace it): the installation's permission
  // policy, consulted by `ctx.gate` at every privileged tool call. Absent ⇒ the asking default, which
  // is what the host boots with anyway.
  permissionGate?: () => PermissionGate | undefined;
  hooks?:          HookRegistry;
  systemContext?:  SystemContextRegistry;
  vault?:          Vault;
  files?:          FileStore;
  // Only for a runner over a store the machine's appender cannot reach — see `MatbotRuntime.ephemeral`.
  appender?:       SessionAppender;
  // Set only for a parallel turn's runner, whose whole life falls inside the hold of the pump that
  // admitted it (that pump waits for its parallel turns before it releases). So this runner's pump takes
  // no hold of its own. Taking one would gain nothing, since nothing deferred can land while the outer
  // hold is up. And it would cost the full admit timeout whenever anything is staged, because the
  // barrier would be waiting for a drain that its own parent prevents.
  heldByCreator?:  true;
  workdir?:        string;
  configPath?:     string;
  loadPlugin:      (specifier: string, prompt?: PromptFn, refresh?: boolean) => Promise<MatbotPlugin>;
  unloadPlugin:    (specifier: string) => Promise<boolean>;
}

const MAX_RESUBMIT_DEPTH = 8;

// Disposition for a `mode: 'auto'` mid-turn submission when no SteeringPolicy is registered (or it
// declares no `classify`). Interrupt-by-default: a message sent while the agent works stops the
// running turn (its committed partial work is preserved) and runs next. Flip to 'queue' to make the
// conservative "wait for the turn boundary" the default — this const is the single knob.
const DEFAULT_STEERING_POLICY: SteeringDecision = 'interrupt';

// The ephemeral nudge folded onto an interrupt's continuation when no SteeringPolicy supplies one. It
// biases the model to continue the interrupted task while accounting for the steer, rather than pivot
// wholesale — the dial between "I'll get to that in a minute" and a full reprioritisation.
const DEFAULT_STEER_NUDGE: MessageContent[] = [{
  type: 'text',
  text: 'The user sent the message above while you were working. Take it into account and keep going — continue the task you were on, incorporating this new input rather than discarding your progress.',
}];

// Marker creator for a retract-and-rerun: its `data.retracted` carries the popped (superseded) turn
// messages so a frontend can render them struck-through and a post-mortem can audit them. Core-owned
// because the pop is a pump operation, not a plugin's.
const RETRACTION_CREATOR = 'matbot-retraction';

/**
 * A tool's description with its wire contract appended — the text the model actually reads for every
 * tool, every turn. Both blocks are fenced identically; the result block used to omit the newline after
 * its label and before its fence, so the type opened inline against "TypeScript result:```" and the
 * block never closed where a reader expects it.
 */
export function wireDescription(description: string, wc: { params: string; result: string } | undefined): string {
  if (wc === undefined) return description;
  const block = (label: string, type: string): string => `${label}:\n\`\`\`\n${type}\n\`\`\``;
  return `${description}\n\n${block('TypeScript params', wc.params)}\n\n${block('TypeScript result', wc.result)}`;
}

const textOf = (m: Message): string =>
  m.content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text').map(c => c.text).join('\n');

// Back across a submission boundary: `ingestMedia` has already turned media into refs, so only these arms
// remain, and the nested runner re-checks the refs against this same session.
const asSubmitted = (content: readonly MessageContent[]): UserContent[] =>
  content.flatMap((c): UserContent[] => c.type === 'text' || c.type === 'file-ref' || c.type === 'form-response' ? [c] : []);

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  const states = new Map<string, SessionState>();

  const stateFor = (id: string): SessionState => {
    let s = states.get(id);
    if (s === undefined) {
      s = { queue: [], running: false, runningTraceId: undefined, ac: undefined, subscribers: new Set(), replay: [], pendingUsage: [],
            parallel: new Map(), merges: [], turnHead: undefined, interjected: [], wake: undefined, writes: [] };
      states.set(id, s);
    }
    return s;
  };

  const maybeCleanup = (id: string, s: SessionState): void => {
    if (!s.running && s.queue.length === 0 && s.subscribers.size === 0 && s.parallel.size === 0 && s.merges.length === 0 && s.writes.length === 0) states.delete(id);
  };

  const pump = async (id: string, s: SessionState): Promise<void> => {
    // Already pumping: it picks this up, though it may be waiting for a parallel turn and need waking.
    if (s.running) { const wake = s.wake; s.wake = undefined; wake?.(); return; }
    s.running = true;
    // Hold the machine for the WHOLE queue, not per turn. A deferred machine mutation (the
    // StorageBackend swap, the remounts a plugin load or unload stages) may only land where no
    // operation spans it — and the pump's own store work does not stop at a turn's end: it reads the
    // committed document back for followup, appends markers to it, rewrites it for a retract, and
    // persists the next turn's user message before that turn opens. All of that sits between turns,
    // and a per-turn hold declared it idle. The queue draining is the real boundary — the same one
    // usage flushes at, for the same reason. `machineBusy` releases on every exit including a throw,
    // so no early return out of the loop below can leave the machine held.
    //
    // It also waits for deferred machine work to land before taking the hold, so a staged swap is in place
    // before the loop below reads anything. That wait used to be spelled at this call site, and spelling
    // it there made it something the next caller of `machineBusy` could omit without any symptom — so it
    // moved inside the hold it guards.
    //
    // Writes of this session from outside its turns are not machine work, and do not wait for the edge:
    // this loop applies them itself, between its turns (`drainWrites`), so they wait only for this
    // session's turns, and the next turn reads what they wrote.
    //
    // The parallel turns this pump admits are part of the same operation. Their tools use the machine
    // just as the queue's turns do, so the hold stays up until they have settled too (see the wait in the
    // loop below), and their own runner takes none (`SessionRunnerDeps.heldByCreator`).
    const drain = async (): Promise<void> => {
      try {
        for (;;) {
          // Not ahead of a redo. A redo re-runs the turn just retracted, found as the session's LAST user
          // message, so a pair appended here would be re-run in its place, on a history ending in an
          // assistant message. Left in `merges`, the pair is placed by the redo's first round instead,
          // ahead of the kept user message, which is where the copy it ran on ended. Writes wait for the
          // redo to end, for the same reason and because one could remove the message it re-runs.
          //
          // Writes before replies: a cut queued by the turn just ended drops everything from its anchor
          // to the end, so a parallel reply appended first would go with it.
          if (s.queue[0]?.redo === undefined) {
            await drainWrites(s);
            await drainMerges(deps.store, id, s);
            // One that arrived while the other was writing. Its arrival found the pump busy, so nothing
            // else will come round for it; going on would leave it unwritten, and the session busy.
            if (s.writes.length > 0 || s.merges.length > 0) continue;
          }
          if (s.queue.length === 0) {
            if (s.parallel.size === 0) break;
            // A parallel turn is still out, and this hold covers it. Woken by its settling (its reply is
            // then placed at the top of the loop) or by a new submission. No turn is running meanwhile,
            // so an interrupt or a parallel submission arriving now queues as an ordinary turn.
            s.runningTraceId = undefined;
            await new Promise<void>(resolve => { s.wake = resolve; });
            continue;
          }
          // Per-submission concat: the head always runs; if the head is a concat submission it absorbs
          // the following submissions while they too are concat, stopping at the first non-concat (a turn
          // boundary). Net effect: maximal runs of consecutive concat submissions merge into one turn,
          // while every queued/robo submission stays its own ordered turn — concat and queued mix freely.
          const head  = s.queue.shift()!;
          const batch = [head];
          if (head.concatQueue) {
            while (s.queue.length > 0 && s.queue[0]!.concatQueue) batch.push(s.queue.shift()!);
          }
          const content = batch.flatMap(i => i.content);
          s.runningTraceId = head.traceId;
          // The turn head, in this same step (see `SessionState.turnHead`): a fresh turn's user message is
          // minted here, so its id is known before the read below, and persisted after it; a redo's is the
          // message its retraction kept.
          const userMsg = head.redo === undefined
            ? createMessage({ role: 'user', content, traceId: head.traceId, providerName: head.provider })
            : undefined;
          s.turnHead = userMsg !== undefined ? { id: userMsg.id, request: textOf(userMsg) } : head.redo?.head;
          // In the same synchronous step that takes the item off the queue, so there is no moment at which a
          // stop finds it in neither place: `abort`/`cancelTurn` reach a queued item through the queue and a
          // dequeued one only through this. Created after the preamble below (a store read, the persist,
          // the provider resolving), a stop sent during it found nothing and the turn ran anyway. A turn
          // whose signal is already aborted ends `aborted` at its first round.
          const ac = new AbortController();
          s.ac = ac;
          s.replay = [];
          // Seed replay with the running turn's user message as a single merged `queued`, mirroring the
          // message persisted just below. notify() (in open()) reaches only subscribers that are live at
          // enqueue time; a GET /events/sessions/:id that connects after this synchronous preamble — the
          // common case when the submit POST wins the race against the events stream — would otherwise
          // find an empty queue and a cleared replay, and never render the user bubble. One merged event
          // (not one per batch item) matches both stored history on reload and the live fold, so a late
          // subscriber reconstructs exactly one bubble. A redo carries no new user message (and no
          // content), so it seeds nothing — its retraction marker already went out at enqueue time.
          if (head.redo === undefined) {
            s.replay.push({ type: 'queued', content, queued: 0, concatQueue: false, traceId: head.traceId, rootTraceId: head.rootTraceId });
          }

          let session = await deps.store.get(id);
          if (session === null) {
            s.ac = s.turnHead = undefined;
            emit(s, { type: 'error', error: `Session "${id}" not found`, traceId: head.traceId });
            continue;
          }

          // A redo re-runs the existing committed user turn — no title derivation, no new user message.
          if (userMsg !== undefined) {
            if (!session.title && !session.messages.some(m => m.role === 'user')) {
              // Falls back to the attachment names when the turn has no words of its own: an image-only
              // first turn is a real submission, and got no title at all — which reads in the session
              // list as a session that failed to start.
              const text = content
                .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
                .map(c => c.text).join(' ').trim()
                || content
                  .filter((c): c is Extract<MessageContent, { type: 'file-ref' }> => c.type === 'file-ref')
                  .map(c => c.name).join(', ');
              if (text) {
                const words = text.split(/\s+/).slice(0, 8).join(' ');
                session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
              }
            }

            // Persist-at-turn-start: the user message only hits the store when its turn begins, never
            // while queued. That is what stops a mid-turn submit from clobbering session state. A robo
            // resubmission's blocks already carry `origin: 'robo'` (stamped where it was enqueued).
            session = appendMessage(session, userMsg);
            try {
              await deps.store.set(session.id, session);
            } catch (e) {
              // A read-only store rejects the persist-at-turn-start write (e.g. a session shared read-only
              // from another profile's partition). That is a per-turn condition, not a host fault: surface
              // it as a turn error and drop this submission rather than let it escape the detached pump and
              // crash the process. Any other write failure stays fatal.
              if (!isReadOnlyError(e)) throw e;
              s.ac = s.turnHead = undefined;
              emit(s, { type: 'error', error: e.message, traceId: head.traceId });
              continue;
            }
          }

          const resolved = await deps.resolveProvider(head.provider);
          if (resolved === null) {
            s.ac = s.turnHead = undefined;
            emit(s, { type: 'error', error: `Unknown provider "${head.provider}"`, traceId: head.traceId });
            continue;
          }

          // A redo re-runs an existing turn with its ephemeral; a steer carries an interrupt's nudge. The
          // two never coincide on one item, so either supplies runSession's injectedEphemeral.
          const inject = head.redo?.ephemeral ?? head.injectEphemeral;

          // Fold each tool's wire contract — the `params`/`result` text flattened from its single contract
          // (a source tool's ToolContracts arms, or a source-less tool's `toolContract`) — into its description
          // for this turn, so the model reasons about the real TS shapes, not just the loose inputSchema.
          // Derived here because `services`/ToolTypeIndex are live at dispatch. Tools with only a loose
          // inputSchema (no contract) are left as-is; absent ToolTypeIndex (browser) ⇒ plain descriptions.
          const wire = await deps.toolTypeIndex?.()?.wireContracts();
          const toolPresenter = deps.toolPresenter?.();
          const mediaStore    = deps.mediaStore?.();
          const permissionGate = deps.permissionGate?.();
          const toolMap = deps.tools !== undefined
            ? new Map<string, Tool>(deps.tools.list().map(t => {
                const wc = wire?.[t.name];
                return [t.name, wc !== undefined
                  ? { ...t, description: wireDescription(t.description, wc) }
                  : t];
              }))
            : undefined;

          // The terminal event this turn ended on. `followup` is post-COMMIT, and only `done` is a
          // commit: an `aborted` turn was cut short (a steer, a user cancel, a screen/toolcall hook
          // refusing it, a provider round ceiling) and an `error` turn produced no response at all, so
          // in both cases a followup hook would judge history with no completed answer in it — and a
          // `resubmit` would undo the very stop that just happened, handing a round ceiling a fresh
          // budget. Tracked here rather than inferred from `ac.signal`, which only knows about the two
          // signal-driven aborts and not the policy ones. Declared outside the `try` because `finally`
          // also asks whether the turn committed at all.
          let terminal: PipelineEvent['type'] | undefined;
          try {
            // Establish the submitter's principal for the whole turn here, not inside runSession:
            // pump runs detached (`void pump`), so this scope — not the request that enqueued — is the
            // turn's async root. Everything downstream (hooks, tools, and any Store/FileStore/Vault
            // access they trigger) reads it via currentPrincipal(). The consumption is inside the callback
            // because the pump owns it, not because it must be: runAs rescopes a returned iterator itself.
            // runAs, not a context switch of its own: the pump holds the machine across the whole queue
            // (see above), so a turn declares only its owner. Each item carries its own submitter.
            // One usage scope per pump ITERATION rather than per turn. `followup` is post-commit by
            // definition and a detached classifier settles whenever it settles, so a scope that ended at
            // the turn's commit would drop precisely the spend that is hardest to account for otherwise.
            // The entries array is registered for flush before any work starts, so a late arrival lands
            // in something already tracked and needs no coordination of its own.
            await withUsageScope(async usage => {
              s.pendingUsage.push(usage.entries);
              await runAs(head.principal, async () => {
                for await (const ev of runSession({
                  session,
                  config:         { provider: head.provider, traceId: head.traceId },
                  provider:       resolved.adapter,
                  providerConfig: resolved.config,
                  store:          deps.store,
                  signal:         ac.signal,
                  loadPlugin:     deps.loadPlugin,
                  unloadPlugin:   deps.unloadPlugin,
                  ...(toolMap            !== undefined ? { tools:         toolMap            } : {}),
                  ...(deps.tools         !== undefined ? { toolRegistry:  deps.tools         } : {}),
                  ...(toolPresenter      !== undefined ? { toolPresenter                     } : {}),
                  ...(deps.hooks         !== undefined ? { hooks:         deps.hooks         } : {}),
                  ...(deps.systemContext !== undefined ? { systemContext: deps.systemContext } : {}),
                  ...(deps.workdir       !== undefined ? { workdir:       deps.workdir       } : {}),
                  ...(deps.files         !== undefined ? { files:         deps.files         } : {}),
                  ...(deps.appender      !== undefined ? { appender:      deps.appender      } : {}),
                  ...(mediaStore         !== undefined ? { mediaStore                        } : {}),
                  ...(permissionGate     !== undefined ? { permissionGate                    } : {}),
                  ...(deps.configPath    !== undefined ? { configPath:    deps.configPath    } : {}),
                  ...(deps.vault         !== undefined ? { vault:         deps.vault         } : {}),
                  ...(head.prompt        !== undefined ? { prompt:        head.prompt        } : {}),
                  ...(inject             !== undefined ? { injectedEphemeral: inject } : {}),
                  interject:      interjectInto(s),
                })) {
                  if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') terminal = ev.type;
                  emit(s, ev);
                }
              });
              s.turnHead = undefined;

              // followup — post-commit, in the queue owner. A hook reads the just-committed turn and may
              // head-enqueue a robo follow-up (its own real turn, running next). Runs only for a turn that
              // committed (see `terminal`), and under the submitter's principal because a reactor may itself
              // call complete() (a classifier).
              const hooks = deps.hooks;
              if (terminal === 'done' && hooks) {
                const committed = await deps.store.get(id);
                if (committed && head.resubmitDepth < MAX_RESUBMIT_DEPTH) {
                  let followup: { resubmits: MessageContent[][]; markers: MessageContent[]; retract?: { context: MessageContent[]; durable: MessageContent[] } } = { resubmits: [], markers: [] };
                  await runAs(head.principal, async () => {
                    followup = await hooks.runFollowup({
                      session:       committed,
                      resubmitDepth: head.resubmitDepth,
                      config:        { provider: head.provider, traceId: head.traceId },
                      signal:        ac.signal,
                      ...(head.prompt !== undefined ? { prompt: head.prompt } : {}),
                    });
                  });
                  const resubmits = followup.resubmits;

                  // Durable markers a followup hook returned (e.g. a fired trigger's silent tool tracing
                  // what it did). Append-only to the just-committed session; the pump is the sole writer
                  // post-commit, so an unconditional set is safe. Emitted live too (post-`done`, like a
                  // `queued` event) so a live draw matches a reload — the engine surfaces everything it
                  // persists; a frontend filters if it wants to. Skipped when retracting: the pop rewrites
                  // the message tail, so these markers are folded into that single write instead (below)
                  // to keep ordering sane (a separate append here would be sliced into the popped region).
                  if (followup.markers.length > 0 && !followup.retract) {
                    const markerMsg = createMessage({ role: 'marker', content: followup.markers, traceId: head.traceId });
                    await rewrite(deps.store, id, committed, cur => ({ ...cur, messages: [...cur.messages, markerMsg] }),
                      `[matbot] followup markers of session "${id}" were not written`);
                    notify(s, { type: 'marker', content: followup.markers, traceId: head.traceId });
                  }
                  // unshift in reverse so the hooks' order is preserved at the head of the queue. Stamp
                  // every block `origin: 'robo'` here — once — so it rides into both the live `queued`
                  // event and the persisted user message the pump builds from this item.
                  for (const raw of resubmits.reverse()) {
                    const rt = crypto.randomUUID();
                    // Every block, not just text: `origin` is authorship, orthogonal to what the block
                    // carries, and a resubmission that attached an image was silently presenting it as the
                    // user's own. The arms a stamp would be wrong on don't occur here — a hook returns
                    // content, not a thinking block — so a blanket stamp beats an arm-by-arm list.
                    const content = raw.map(c => ({ ...c, origin: 'robo' as const }));
                    s.queue.unshift({
                      traceId:       rt,
                      rootTraceId:   head.rootTraceId,
                      content,
                      provider:      head.provider,
                      principal:     head.principal,
                      concatQueue:   false,
                      resubmitDepth: head.resubmitDepth + 1,
                    });
                    notify(s, { type: 'queued', content, queued: 0, concatQueue: false, traceId: rt, rootTraceId: head.rootTraceId });
                  }

                  // retract-and-rerun: pop the just-committed turn back to (and excluding) the last user
                  // message, stash the popped messages in a durable retraction marker (LLM-elided like any
                  // marker — so the model never re-reads its superseded answer — but carried in `data` for
                  // a strike-through render and audit), then re-enqueue a redo of that same user turn at the
                  // head, delivering the trigger tool's output as ephemeral context. Unshifted last so it
                  // sits at the very head (runs next) even if a resubmit was also queued above.
                  if (followup.retract) {
                    // `durable` correction (a contextual fire that landed post-commit) folds onto the user
                    // message we keep — persisted, so the redo AND every later turn see it in history, the
                    // exact durability the clean in-situ path gives. `context` stays ephemeral (redo only).
                    // The fold runs on the *truncated* session, whose last user message is the one we keep,
                    // so it goes through the same helper as the screen and raced-verdict folds.
                    const durable = followup.retract.durable ?? [];
                    // Any followup markers ride along as a trailing marker message (not folded into the
                    // retraction marker) so each creator's trace stays its own block.
                    const trailing: Message[] = followup.markers.length > 0
                      ? [createMessage({ role: 'marker', content: followup.markers, traceId: head.traceId })]
                      : [];
                    // Recomputed per attempt: a settled parallel pair may have been placed while the hooks
                    // judged, ahead of the turn we are about to pop, so the landmarks are taken from the
                    // document we are actually writing over. Every one of them is "the last user message",
                    // which a pair placed ahead of it does not move — so this changes nothing but which
                    // document the kept prefix comes from.
                    let keptHead:      Message | undefined;
                    let retractionMsg: Message | undefined;
                    const wrote = await rewrite(deps.store, id, committed, cur => {
                      const lastUserIdx = lastUserIndex(cur);
                      const popped      = lastUserIdx >= 0 ? cur.messages.slice(lastUserIdx + 1) : [];
                      const truncated   = lastUserIdx >= 0
                        ? { ...cur, messages: cur.messages.slice(0, lastUserIdx + 1) }
                        : cur;
                      const kept = foldOntoUserTurn(truncated, durable).messages;
                      // The redo's turn head: the user message kept here, as folded — what it re-runs.
                      keptHead      = lastUserIdx >= 0 ? kept[lastUserIdx] : undefined;
                      retractionMsg = createMessage({
                        role:    'marker',
                        traceId: head.traceId,
                        // `retracted` is what was popped (the superseded answer); `injected` is the ephemeral
                        // context fed to the redo — neither is otherwise persisted, so the pair fully traces
                        // the swap for a post-mortem (and a frontend can render the strike-through + the cause).
                        content: [{ type: 'marker', creator: RETRACTION_CREATOR, data: { retracted: popped, injected: followup.retract?.context ?? [], traceId: head.traceId } }],
                      });
                      return { ...cur, messages: [...kept, retractionMsg, ...trailing] };
                    }, `[matbot] the retraction of session "${id}" was not written; it will not be re-run`);
                    // Only if it landed: nothing was popped otherwise, so there is nothing to re-run and
                    // nothing to announce — a redo enqueued here would re-answer a turn whose original
                    // answer is still in the session.
                    if (wrote && retractionMsg !== undefined) {
                      // Emit the durable fold live (as a robo-user on the kept user turn) before the
                      // retraction marker, mirroring the screen-time durable path's ordering.
                      if (durable.length > 0) notify(s, { type: 'robo-user', content: durable, traceId: head.traceId });
                      notify(s, { type: 'marker', content: retractionMsg.content, traceId: head.traceId });
                      if (trailing.length > 0) notify(s, { type: 'marker', content: followup.markers, traceId: head.traceId });

                      const rt = crypto.randomUUID();
                      s.queue.unshift({
                        traceId:       rt,
                        rootTraceId:   head.rootTraceId,
                        content:       [],
                        provider:      head.provider,
                        principal:     head.principal,
                        concatQueue:   false,
                        resubmitDepth: head.resubmitDepth + 1,
                        redo:          {
                          ephemeral: followup.retract.context ?? [],
                          ...(keptHead !== undefined ? { head: { id: keptHead.id, request: textOf(keptHead) } } : {}),
                        },
                        ...(head.prompt !== undefined ? { prompt: head.prompt } : {}),
                      });
                    }
                  }
                }
              }
            }, { traceId: head.traceId, rootTraceId: head.rootTraceId });
          } catch (e) {
            emit(s, { type: 'error', error: String(e), traceId: head.traceId });
          } finally {
            s.ac = undefined;
            s.turnHead = undefined;
            // Every terminal commits, and the replies placed into the turn went with it. No terminal means
            // runSession threw before committing, taking them with it — so they go back to be placed again.
            // Not one `placeNow` already wrote: that is in the store whatever this turn did, and placing
            // it again would duplicate the pair.
            const placed = s.interjected.splice(0);
            if (terminal === undefined) s.merges.unshift(...placed.filter(r => r.persisted !== true));
          }
        }
      } finally {
        s.runningTraceId = undefined;
        s.turnHead = undefined;
        s.ac = undefined;
        s.replay  = [];
        try {
          // Accounting is flushed HERE — at the drained queue, not at a turn boundary. "The end of a turn"
          // is not a well-defined moment to total anything at: steers terminate and resume, a retract
          // re-enqueues the turn it just popped, followup enqueues resubmissions, and a detached classifier
          // settles whenever it settles. The queue draining is unambiguous, and it is after all of them.
          //
          // And while `running` still holds. The flush is a read-modify-write of the session, so a
          // submission arriving during it must queue behind this pump rather than start a second one —
          // whose persist-at-turn-start write would interleave with it, and whichever landed second
          // erased the other: this flush's entries, or that turn's user message.
          await flushUsage(deps.store, id, s);
        } finally {
          s.running = false;
          // A submission or a write that arrived during the flush found the pump running and did not start
          // one; nor did a parallel reply that settled then — possible only when a throw left the loop above
          // with parallel turns still out, since it otherwise ends only once none are.
          if (s.queue.length > 0 || s.merges.length > 0 || s.writes.length > 0) void pump(id, s);
          else {
            // Deterministic busy→idle signal: running is now false, so any subscriber draining the stream
            // (a frontend's status tracker) reads an authoritative idle the moment it sees this — no racing
            // the microtask on which `running` flipped. Not in `replay` (transient lifecycle, not history).
            notify(s, { type: 'idle', sessionId: id });
            maybeCleanup(id, s);
          }
        }
      }
    };
    return deps.heldByCreator ? drain() : machineBusy(drain);
  };

  /**
   * A parallel turn: the submission runs at once on a nested runner over a private copy of the session's
   * completed turns, and its submission plus everything it produced come back (`ParallelReply`). The copy ends where the
   * running turn's own messages begin (`head`), plus any replies already placed into that turn but not
   * yet committed (`interjected`) — both captured at submit, before any await could outlive the turn.
   *
   * Its events are forwarded under its own traceId as progress; what persists is the span the write-back
   * carries, read from the copy once the turn has settled. A nested runner rather than `runSession` so the turn is an ordinary
   * one — screen, followup, accounting, media — with nothing re-implemented.
   */
  const runParallel = async (
    id: string, s: SessionState, rec: { replay: PipelineEvent[]; stop: AbortController },
    p: { traceId: string; content: MessageContent[]; provider: string; principal: Principal; prompt?: PromptFn;
         head: { id: string; request: string } | undefined; interjected: Message[] },
  ): Promise<void> => {
    const forward = (ev: PipelineEvent): void => {
      rec.replay.push(ev);
      for (const sink of s.subscribers) sink.push(ev);
    };
    let reply: ParallelReply | undefined;
    try {
      const stored = await deps.store.get(id);
      if (stored === null) { forward({ type: 'error', error: `Session "${id}" not found`, traceId: p.traceId }); return; }
      // The head may not be in the store yet — the turn's user message is persisted after the head is set
      // — in which case nothing of the running turn is there to cut.
      const at       = p.head !== undefined ? stored.messages.findIndex(m => m.id === p.head!.id) : -1;
      const prefix   = at >= 0 ? stored.messages.slice(0, at) : stored.messages;
      // By the time this read lands the running turn may have committed, interjected replies included.
      const have     = new Set(prefix.map(m => m.id));
      const copy     = { ...stored, messages: [...prefix, ...p.interjected.filter(m => !have.has(m.id))] };
      const running  = p.head?.request ?? '';
      const framing  = running ? parallelFraming(running) : undefined;

      const store = new MemoryStore<Session>();
      await store.set(id, copy);
      const sub = createSessionRunner({ ...deps, store, heldByCreator: true });
      if (rec.stop.signal.aborted) { forward({ type: 'cancelled', sessionId: id, traceId: p.traceId }); return; }
      rec.stop.signal.addEventListener('abort', () => sub.abort(id), { once: true });

      // Tap BEFORE submitting: the nested pump starts inside `open`, and an event (or its `idle`) emitted
      // before a later tap would be missed — the last of them leaving this loop waiting for ever.
      const tapAc = new AbortController();
      const tap   = (await sub.open({ sessionId: id, signal: tapAc.signal })).events;
      await sub.open({
        sessionId: id, signal: tapAc.signal, traceId: p.traceId, provider: p.provider, principal: p.principal,
        content: [...asSubmitted(p.content), ...(running ? [parallelFraming(running)] : [])],
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
      });
      // Again, now that there is something to stop: a stop landing while the submission was on its way in
      // (its media boundary is an await) reached a runner with nothing queued, and the listener has fired.
      if (rec.stop.signal.aborted) sub.abort(id);
      for await (const ev of tap) {
        if (ev.type === 'idle') break;
        // Announced as `parallel` already, with the content as submitted rather than the framed copy.
        if (ev.type === 'queued') continue;
        forward(ev);
      }
      tapAc.abort();

      const final  = await store.get(id);
      const msgs   = final?.messages ?? [];
      const hIdx   = msgs.findIndex(m => m.role === 'user' && m.traceId === p.traceId);
      const qHead  = msgs[hIdx];
      // The turn's WHOLE span crosses back, not just its final text: thinking, tool calls, their results
      // and any markers. A history holding only the answer makes everything a parallel turn actually did
      // unrecoverable the moment the live stream is gone — `determine_provenance` reads a real tool result
      // as fabricated, and so does a person scrolling back. The span is placed exactly where the copy was
      // cut, so it sits in the history it was generated against, and `closedSpan` is what keeps it valid
      // wire. Thinking rides along persisted but unsubmitted (every adapter elides a historical block),
      // and a foreign round-trip token is the adapters' to drop by `providerName`, which these messages
      // carry — so nothing here depends on which provider ran the turn.
      const span   = hIdx >= 0 ? closedSpan(msgs.slice(hIdx + 1)) : [];
      // Answered iff the span ENDS with assistant text. Not "contains some": a turn aborted after
      // "let me check that" has said nothing, and a span ending on a tool result needs the note after it
      // to close the turn on an assistant message.
      const tail   = span[span.length - 1];
      const answer = tail?.role === 'assistant'
        ? tail.content.filter(c => c.type === 'text' && c.text.trim() !== '') : [];
      const ended  = rec.replay.findLast(e => e.type === 'done' || e.type === 'aborted' || e.type === 'error' || e.type === 'cancelled');
      const reason = ended?.type === 'aborted' ? `was stopped (${ended.reason})`
                   : ended?.type === 'cancelled' ? 'was stopped before it started'
                   : ended?.type === 'error'   ? `failed: ${ended.error}`
                   : 'produced no text';
      reply = {
        traceId:  p.traceId,
        ...(p.head !== undefined ? { head: p.head.id } : {}),
        messages: [
          // The copy's own head, carrying its accounting, with the framing block taken back OFF — that
          // block is this turn's own context and not something the person wrote. Subtracted rather than
          // replaced with `p.content` wholesale: a `contextual` trigger folds its correction DURABLY onto
          // the head, and overwriting the content dropped exactly that, so the correction informed the
          // answer and then vanished from the history the answer sits in.
          qHead !== undefined
            ? { ...qHead, content: qHead.content.filter(c => !(framing !== undefined && c.type === 'text'
                && c.origin === framing.origin && c.text === framing.text)) }
            : createMessage({ role: 'user', content: p.content, traceId: p.traceId, providerName: p.provider }),
          ...span,
          ...(answer.length > 0 ? [] : [createMessage({
            role: 'assistant', content: [{ type: 'text', text: `(No reply — this message's parallel turn ${reason}.)` }],
            traceId: p.traceId, providerName: p.provider })]),
        ],
      };
    } catch (e) {
      forward({ type: 'error', error: String(e), traceId: p.traceId });
    } finally {
      s.parallel.delete(p.traceId);
      if (reply !== undefined) {
        // On the list BEFORE the write below, and never only in the write: the turn may end while we are
        // writing, and then `end`'s final pull or `drainMerges` is the path that places this pair. Being
        // on the list is also how the running turn's in-memory session learns of it, so its whole-document
        // write-back carries the pair instead of erasing it.
        s.merges.push(reply);
        // Placed NOW while a turn is in progress, rather than left for that turn's next round boundary,
        // which a turn parked in one long tool call never reaches — nor does one whose rounds are over and
        // whose `followup` hooks are still judging it, which with LLM-judged trigger conditions is seconds.
        // `ac` spans the whole turn, followup included; `turnHead` does not, and is not what anchors this.
        // A reply with no head of its own belongs at the TAIL, which is the pump's to append and must wait
        // for it: appended now it would become the session's last user message, which is the turn a redo
        // re-runs. A failure places it exactly as it used to be.
        if (s.ac !== undefined && reply.head !== undefined) {
          let placed: 'inserted' | 'present' | 'no' = 'no';
          try {
            placed = await placeNow(deps.store, id, reply);
          } catch (e) {
            console.error(`[matbot] placing a parallel reply of session "${id}" failed:`,
              e instanceof Error ? e : String(e));
          }
          reply.persisted = placed !== 'no';
          // Only the writer that inserted it announces. `into` is the running turn: the pair went ahead of
          // its user message, which is where the copy this ran on ended.
          if (placed === 'inserted') {
            notify(s, { type: 'merged', traceId: reply.traceId,
              ...(s.runningTraceId !== undefined ? { into: s.runningTraceId } : {}) });
          }
        }
      }
      // Placed by the running turn if there is one (it is polled each round), else by the pump that admitted
      // this turn, which is waiting for it.
      void pump(id, s);
    }
  };

  return {
    async open(opts: OpenOpts | SubmitOpenOpts): Promise<SessionView> {
      // For a pure read (no content, events never tapped) we must not materialise a state entry —
      // otherwise every session_action `get` would leak one. State is created only when there is
      // something to queue or someone to subscribe.
      let s = states.get(opts.sessionId);

      let traceId: string | undefined;
      if ('content' in opts) {
        // Belt-and-braces: the union enforces this for TS callers, but a frontend deserialising a
        // request body can still hand us a malformed object — fail loudly at the boundary.
        if (opts.provider === undefined || opts.principal === undefined) {
          throw new Error('open(): submitting content requires both provider and principal');
        }
        s = stateFor(opts.sessionId);
        traceId = opts.traceId ?? crypto.randomUUID();
        const { provider, principal } = opts;
        const mode = opts.mode ?? 'queue';

        // Which turn a steer is FOR is fixed here, before the first await, and checked again before the
        // abort. `s.running` alone cannot answer it: it is true across the pump's whole queue, so it
        // says "something is running", not "still the one you meant". Every await below can outlive a
        // turn — the classifier and the nudge could already, and media ingestion can hold for seconds
        // on a large attachment — after which aborting on `s.running` kills whatever is running NOW,
        // a turn the user never saw, and names the wrong `interruptedTraceId` on the way.
        const steerTarget = s.runningTraceId;

        // The media boundary, before anything else this submission touches: by-value attachments are
        // written through the MediaStore and become `file-ref`s here, so nothing downstream — the
        // steering classifier, the `queued`/`steer` events, the persisted user message — ever sees
        // bytes. One place, and every frontend inherits it, which is what lets Telegram (where bytes
        // arrive WITH the message and there is no upload-in-advance leg) work with no code of its own.
        // Throws MediaRejectedError on a refusal; nothing is enqueued, so the caller has nothing to
        // undo — it just tells the user which file and why.
        const content = await ingestMedia(opts.content, opts.sessionId, deps.mediaStore?.());

        // Decide interrupt vs queue for a submission arriving mid-turn. Steering is only meaningful
        // while a turn is running; with nothing running it enqueues and runs next regardless of mode.
        // The decision — and, on interrupt, the abort+unshift — happen here synchronously against
        // s.running (re-checked after any classify/nudge await) so an interrupt can never land on the
        // wrong (a later) turn: the fatal race of deciding across a wire is closed by deciding in-runner.
        let handled = false;
        if (mode !== 'queue' && s.running) {
          const policy = deps.steeringPolicy?.();
          // Fetch the committed session once (history up to the running turn's start) only when a policy
          // member actually needs it: classify under `auto`, and nudge on any interrupt. The common
          // no-policy interrupt path (e.g. the web default) does no extra read.
          const wantClassify = mode === 'auto' && policy?.classify !== undefined;
          const wantNudge    = policy?.nudge !== undefined;
          const committed = (wantClassify || wantNudge) ? await deps.store.get(opts.sessionId) : null;

          const decision: SteeringDecision = mode === 'interrupt' || mode === 'parallel'
            ? mode
            : policy?.classify !== undefined
              ? (committed ? await policy.classify({ session: committed, steer: content }) : DEFAULT_STEERING_POLICY)
              : DEFAULT_STEERING_POLICY;

          // Any await above may have outlived the turn this steer was for: interrupt only if THAT one
          // is still the running turn. Otherwise fall through and queue — the turn they were steering
          // has already committed, which makes this an ordinary follow-up rather than an interruption.
          // `running` alone is not "a turn is running": it holds through the usage flush after the queue
          // drains, where `runningTraceId` is already cleared — and `steerTarget` captured then is
          // undefined too, so without the first test the two compare equal and nothing gets steered.
          if (decision === 'interrupt' && s.runningTraceId !== undefined && s.runningTraceId === steerTarget) {
            const nudge = policy?.nudge !== undefined && committed
              ? policy.nudge({ session: committed, steer: content })
              : DEFAULT_STEER_NUDGE;
            const interruptedTraceId = s.runningTraceId;
            // Head of the queue (ahead of anything else already queued): the steer runs immediately
            // after the interrupted turn commits its partial work. Own turn (never concat).
            s.queue.unshift({
              traceId,
              rootTraceId:     traceId,
              content,
              provider,
              principal,
              concatQueue:     false,
              resubmitDepth:   0,
              injectEphemeral: nudge,
              ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
            });
            // Announce the steer before aborting so a subscriber places the new bubble and reads the
            // imminent `aborted` (reason 'steer') as a yield, not a dead-end.
            notify(s, { type: 'steer', content, interruptedTraceId, traceId, rootTraceId: traceId });
            s.ac?.abort('steer');
            handled = true;
          }

          // Unlike a steer, a parallel turn needs no particular turn to still be running — only SOME turn,
          // since that is what it runs beside. Its copy is cut at whichever turn that is, captured here,
          // synchronously, because the next await could outlive it.
          if (decision === 'parallel' && s.running && s.runningTraceId !== undefined) {
            const rec = { replay: [] as PipelineEvent[], stop: new AbortController() };
            const announce: PipelineEvent = { type: 'parallel', content, runningTraceId: s.runningTraceId, traceId, rootTraceId: traceId };
            rec.replay.push(announce);
            s.parallel.set(traceId, rec);
            notify(s, announce);
            void runParallel(opts.sessionId, s, rec, {
              traceId, content, provider, principal,
              head:        s.turnHead,
              interjected: s.interjected.flatMap(r => r.messages),
              ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
            });
            handled = true;
          }
        }

        if (!handled) {
          const concatQueue = opts.concatQueue ?? false;
          s.queue.push({
            traceId,
            rootTraceId:   traceId,
            content,
            provider,
            principal,
            concatQueue,
            resubmitDepth: 0,
            ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
          });
          // Announce the submission on the stream as part of the live delta, before its turn's events.
          // If it runs immediately `queued` is 0 (no wait); otherwise it's how many are ahead. concatQueue
          // tells a frontend whether this submission will merge into the running batch (so it can fold the
          // bubble) or run as its own turn.
          notify(s, { type: 'queued', content, queued: aheadOf(s, s.queue.length - 1), concatQueue, traceId, rootTraceId: traceId });
        }
        void pump(opts.sessionId, s);
      }

      // Stored state is pure committed history (ends at the running turn's user message). The pending
      // queue and the in-progress response are the "delta", delivered over `events` — never overlaid
      // here — so `stored ++ delta` concatenates in a single, refresh-stable order.
      const base = await deps.store.get(opts.sessionId);
      if (base === null) throw new Error(`Session "${opts.sessionId}" not found`);

      let cached: AsyncIterable<PipelineEvent> | undefined;
      const view: SessionView = {
        session: base,
        queued: s !== undefined ? s.queue.length : 0,
        ...(traceId !== undefined ? { traceId } : {}),
        get events(): AsyncIterable<PipelineEvent> {
          if (cached === undefined) {
            const st = stateFor(opts.sessionId);
            const remove = (): void => { st.subscribers.delete(sink); maybeCleanup(opts.sessionId, st); };
            const sink = createSink(remove);
            st.subscribers.add(sink);
            // Replay the in-progress turn, any parallel turns beside it, then the pending queue — the delta
            // region, in order.
            for (const ev of st.replay) sink.push(ev);
            for (const { replay } of st.parallel.values()) for (const ev of replay) sink.push(ev);
            st.queue.forEach((item, i) =>
              sink.push({ type: 'queued', content: item.content, queued: aheadOf(st, i), concatQueue: item.concatQueue, traceId: item.traceId, rootTraceId: item.rootTraceId }));
            if (opts.signal.aborted) { sink.close(); remove(); }
            else opts.signal.addEventListener('abort', () => { sink.close(); remove(); }, { once: true });
            cached = sink.iterable;
          }
          return cached;
        },
      };
      return view;
    },

    abort(sessionId: string): void {
      const s = states.get(sessionId);
      if (s === undefined) return;
      for (const item of s.queue.splice(0)) {
        emit(s, { type: 'cancelled', sessionId, traceId: item.traceId });
      }
      s.ac?.abort('user-abort');
      for (const { stop } of s.parallel.values()) stop.abort('user-abort');
    },

    abortParallel(sessionId: string, traceId: string): boolean {
      // Only this turn's own stop. Nothing else is touched — not the running turn it was answered
      // beside, not the queue, not its siblings — and it settles through the ordinary path, so its pair
      // is still written back with a note where the reply would have been.
      const rec = states.get(sessionId)?.parallel.get(traceId);
      rec?.stop.abort('user-abort');
      return rec !== undefined;
    },

    cancelTurn(sessionId: string): void {
      const s = states.get(sessionId);
      if (s === undefined) return;
      // Deliberately no queue splice: cancel abandons only the running turn; queued submissions are
      // separate operations the user lined up and survive into the next `pump` iteration.
      s.ac?.abort('user-cancel');
    },

    status(sessionId: string): { busy: boolean; running: boolean; queued: number; parallel: number } {
      const s = states.get(sessionId);
      const running  = s?.running ?? false;
      const queued   = s?.queue.length ?? 0;
      const parallel = s?.parallel.size ?? 0;
      return { busy: running || queued > 0 || parallel > 0 || (s?.merges.length ?? 0) > 0, running, queued, parallel };
    },

    write(sessionId: string, attempt: () => Promise<boolean>, lost: string): SessionWrite {
      const s = stateFor(sessionId);
      // As the caller. The pump runs in the scope of whatever started it, and the store checks ownership.
      const principal = tryCurrentPrincipal();
      // It waits for a turn exactly when one is in progress (`ac` is set from dequeue until the turn,
      // followup included, is done), or when a redo is next — it waits for that too (see the loop).
      // Otherwise the pump reaches it before taking the next turn off the queue.
      const deferred = s.ac !== undefined || s.queue[0]?.redo !== undefined;
      let settle!: () => void;
      const done = new Promise<void>(resolve => { settle = resolve; });
      const tries = async (): Promise<void> => {
        for (let n = 0; n < WRITE_ATTEMPTS; n++) if (await attempt()) return;
        console.error(lost);
      };
      s.writes.push(async () => {
        try {
          await (principal !== undefined ? runAs(principal, tries) : tries());
        } catch (e) {
          // Nobody may be awaiting it, and the pump must go on to the next write and turn.
          console.error(`[matbot] a write of session "${sessionId}" failed:`, e instanceof Error ? e : String(e));
        } finally {
          settle();
        }
      });
      // On a microtask, so the write cannot start before this returns: a caller decides what to do from
      // `deferred`, and its attempt may read what it set after the call.
      queueMicrotask(() => { void pump(sessionId, s); });
      return { deferred, done };
    },
  };
}
