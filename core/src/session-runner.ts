import type {
  Session, Message, MessageContent, Principal, PromptFn, PipelineEvent,
  Store, ToolRegistry, SystemContextRegistry, Vault, FileStore, Tool,
  ProviderAdapter, ProviderConfig, SessionRunner, SessionView, OpenOpts, SubmitOpenOpts,
  SteeringPolicy, SteeringDecision, UsageRecord,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { HookRegistry } from './hooks.js';
import type { ToolTypeIndex, ToolPresenter } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from './session.js';
import { isReadOnlyError, foldOntoUserTurn, lastUserIndex } from '@matatbread/matbot-plugin-api';
import { contextSwitch, withUsageScope } from '@matatbread/matbot-plugin-api/host';
import { runSession } from './runner.js';

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
  hooks?:          HookRegistry;
  systemContext?:  SystemContextRegistry;
  vault?:          Vault;
  files?:          FileStore;
  workdir?:        string;
  configPath?:     string;
  loadPlugin:      (specifier: string, prompt?: PromptFn, refresh?: boolean) => Promise<MatbotPlugin>;
  unloadPlugin:    (specifier: string) => Promise<boolean>;
}

interface QueuedItem {
  traceId:     string;
  // The originating human turn's traceId, carried down a resubmission chain (a human submit is its
  // own root). Lets a per-turn frontend (e.g. telegram) adopt the followups *its* turn spawned and
  // ignore unrelated turns — lineage the bare per-turn traceId can't express.
  rootTraceId: string;
  content:     MessageContent[];
  provider:    string;
  principal:   Principal;
  concatQueue: boolean;
  // 0 for an external submission; a `react` resubmission carries its parent's depth + 1. The reactor
  // budgets against it, and pump hard-caps it (MAX_RESUBMIT_DEPTH) so a misbehaving reactor can't loop.
  resubmitDepth: number;
  // Present ⇒ this item RE-RUNS an already-committed user turn (an agent-phase retract-redo) rather
  // than introducing a new user message: the pump skips the persist-at-turn-start append (the user
  // message already exists) and hands `ephemeral` (the trigger tool's output) to runSession, which
  // tail-folds it for this run only. `content` is empty for such an item — there is no new bubble.
  redo?: { ephemeral: MessageContent[] };
  // Turn-scoped ephemeral context to fold onto this item's turn (tail-folded, never persisted) — used
  // to carry an interrupt's "keep going, noting the above" nudge. Feeds runSession's injectedEphemeral,
  // the same path `redo` uses; the two are mutually exclusive in practice (redo re-runs an existing
  // turn with no new message, a steer introduces a new user message).
  injectEphemeral?: MessageContent[];
  prompt?:     PromptFn;
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

interface SessionState {
  // The queue is deliberately a plain array, drained FIFO. concatQueue is per-submission: a non-concat
  // submission is its own turn — faithful, and correct when one submission's tools/state are a
  // precondition for the next (e.g. "add plugin X" then "use X": tools are rebuilt per turn, so X is
  // only visible to a *later* turn). A run of consecutive concat submissions merges into one turn —
  // cheaper, and the common "let me add more context now" case — without collapsing the queued/robo
  // submissions interleaved among them (see the batch-building loop in pump). Concat and queued mix freely.
  queue:       QueuedItem[];
  running:     boolean;
  // traceId of the turn currently running (set at pump loop top, cleared when the turn ends). Lets an
  // interrupt name the turn it is yielding, so a frontend correlates the `steer` event's
  // `interruptedTraceId` with the `aborted` (reason 'steer') it is about to see.
  runningTraceId: string | undefined;
  ac:          AbortController | undefined;
  subscribers: Set<Sink>;
  // Events of the *current* turn, replayed to a subscriber that joins mid-turn. Cleared at each
  // turn boundary — committed history comes from the store, not from here.
  replay:      PipelineEvent[];
  // Accounting entries awaiting a flush, held BY REFERENCE to each turn's usage scope. A completion
  // can be recorded after its turn commits — a detached trigger classifier, a `followup` hook — and it
  // appends to the very array captured here, so a late arrival needs no coordination: whatever is in
  // these arrays at the flush is what gets written, and each entry says which turn caused it.
  pendingUsage: UsageRecord[][];
}

interface Sink {
  push(ev: PipelineEvent): void;
  close(): void;
  iterable: AsyncIterable<PipelineEvent>;
}

// A single-consumer push channel surfaced as an AsyncIterable. `dispose` runs when the consumer
// stops (break/return) or the channel closes, so an abandoned subscriber unregisters itself.
function createSink(dispose: () => void): Sink {
  const buffer: PipelineEvent[] = [];
  let waiting: ((r: IteratorResult<PipelineEvent>) => void) | null = null;
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w({ value: undefined as never, done: true }); }
  };

  return {
    push(ev) {
      if (closed) return;
      if (waiting) { const w = waiting; waiting = null; w({ value: ev, done: false }); }
      else buffer.push(ev);
    },
    close: finish,
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<PipelineEvent> {
        return {
          next() {
            const head = buffer.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed)            return Promise.resolve({ value: undefined as never, done: true });
            return new Promise(res => { waiting = res; });
          },
          return() {
            finish();
            dispose();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    },
  };
}

export function wireDescription(description: string, wc: { params: string; result: string } | undefined) {
  return wc
    ? `${description}\n\nTypeScript params:\n\`\`\`\n${wc.params}\n\`\`\`\n\nTypeScript result:\`\`\`${wc.result}\n\`\`\``
    : description;
}

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  const states = new Map<string, SessionState>();

  const stateFor = (id: string): SessionState => {
    let s = states.get(id);
    if (s === undefined) {
      s = { queue: [], running: false, runningTraceId: undefined, ac: undefined, subscribers: new Set(), replay: [], pendingUsage: [] };
      states.set(id, s);
    }
    return s;
  };

  const maybeCleanup = (id: string, s: SessionState): void => {
    if (!s.running && s.queue.length === 0 && s.subscribers.size === 0) states.delete(id);
  };

  // Turn events go to the replay buffer (so a mid-flight subscriber sees the in-progress turn) and
  // all live subscribers.
  const emit = (s: SessionState, ev: PipelineEvent): void => {
    s.replay.push(ev);
    for (const sink of s.subscribers) sink.push(ev);
  };

  // Subscribers-only (no replay buffer): used for the `queued` events that describe the pending
  // queue. Pending is NOT kept in `replay` (which is per-turn) — it's reconstructed from `s.queue`
  // when a subscriber joins, so it survives turn boundaries correctly.
  const notify = (s: SessionState, ev: PipelineEvent): void => {
    for (const sink of s.subscribers) sink.push(ev);
  };

  // How many submissions sit ahead of the item at queue index `i` (the running turn counts as one).
  const aheadOf = (s: SessionState, i: number): number => (s.running ? 1 : 0) + i;

  /**
   * Write whatever accounting has accrued onto the turn heads that caused it, then clear it.
   *
   * Entries are drained by SPLICING each pending array, so an entry appended after this point (a
   * classifier still in flight) accumulates afresh and lands on the next flush rather than being
   * written twice. That is the whole concurrency story: no marks, no coordination, and eventual
   * delivery — which is all a log needs, since each entry names the turn that caused it.
   *
   * Anchored on the turn's head (its user message) because that is the message a retract-and-rerun
   * keeps; assistant and tool messages are popped into a retraction marker where no reduction over
   * `session.messages` would find them again. An entry whose turn head has since gone (a session
   * edit, a compaction) is dropped rather than orphaned onto an unrelated message.
   */
  const flushUsage = async (id: string, s: SessionState): Promise<void> => {
    // Splice each array in place and KEEP the references. Dropping a drained array is the obvious
    // tidy-up and it silently loses exactly the case this exists for: a classifier that settles after
    // the flush appends to the array its scope captured, so if the pump has stopped holding it, the
    // write goes nowhere observable. They are left registered for the life of the session state, at a
    // cost of one empty array per turn.
    //
    // The limit of that: `maybeCleanup` disposes the state once the session is quiet and unsubscribed,
    // so a completion still in flight at THAT point is lost. This is the carrier's stated best-effort
    // contract rather than a hole to plug — nothing can know what is still pending — and it is bounded
    // in practice, since the two channels that settle late (a `followup` hook, a user-phase classifier
    // the runner polls) are both awaited inside the pump iteration this scope wraps.
    const drained = s.pendingUsage.flatMap(entries => entries.splice(0));
    if (drained.length === 0) return;

    const session = await deps.store.get(id);
    if (!session) return;

    const byTrace = new Map<string, UsageRecord[]>();
    for (const e of drained) {
      if (e.traceId === undefined) continue;
      const list = byTrace.get(e.traceId);
      if (list) list.push(e); else byTrace.set(e.traceId, [e]);
    }

    let changed = false;
    const messages = session.messages.map(m => {
      const add = m.role === 'user' ? byTrace.get(m.traceId) : undefined;
      if (add === undefined) return m;
      byTrace.delete(m.traceId);
      changed = true;
      return { ...m, usage: [...(m.usage ?? []), ...add] };
    });
    if (!changed) return;
    await deps.store.set(id, { ...session, messages });
  };

  const pump = async (id: string, s: SessionState): Promise<void> => {
    if (s.running) return;
    s.running = true;
    try {
      while (s.queue.length > 0) {
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
          emit(s, { type: 'error', error: `Session "${id}" not found`, traceId: head.traceId });
          continue;
        }

        // A redo re-runs the existing committed user turn — no title derivation, no new user message.
        if (head.redo === undefined) {
          if (!session.title && !session.messages.some(m => m.role === 'user')) {
            const text = content
              .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
              .map(c => c.text).join(' ').trim();
            if (text) {
              const words = text.split(/\s+/).slice(0, 8).join(' ');
              session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
            }
          }

          // Persist-at-turn-start: the user message only hits the store when its turn begins, never
          // while queued. That is what stops a mid-turn submit from clobbering session state. A robo
          // resubmission's blocks already carry `origin: 'robo'` (stamped where it was enqueued).
          session = appendMessage(session, createMessage({ role: 'user', content, traceId: head.traceId, providerName: head.provider }));
          try {
            await deps.store.set(session.id, session);
          } catch (e) {
            // A read-only store rejects the persist-at-turn-start write (e.g. a session shared read-only
            // from another profile's partition). That is a per-turn condition, not a host fault: surface
            // it as a turn error and drop this submission rather than let it escape the detached pump and
            // crash the process. Any other write failure stays fatal.
            if (!isReadOnlyError(e)) throw e;
            emit(s, { type: 'error', error: e.message, traceId: head.traceId });
            continue;
          }
        }

        const resolved = await deps.resolveProvider(head.provider);
        if (resolved === null) {
          emit(s, { type: 'error', error: `Unknown provider "${head.provider}"`, traceId: head.traceId });
          continue;
        }

        // A redo re-runs an existing turn with its ephemeral; a steer carries an interrupt's nudge. The
        // two never coincide on one item, so either supplies runSession's injectedEphemeral.
        const inject = head.redo?.ephemeral ?? head.injectEphemeral;

        const ac = new AbortController();
        s.ac = ac;
        // Fold each tool's wire contract — the `params`/`result` text flattened from its single contract
        // (a source tool's ToolContracts arms, or a source-less tool's `toolContract`) — into its description
        // for this turn, so the model reasons about the real TS shapes, not just the loose inputSchema.
        // Derived here because `services`/ToolTypeIndex are live at dispatch. Tools with only a loose
        // inputSchema (no contract) are left as-is; absent ToolTypeIndex (browser) ⇒ plain descriptions.
        const wire = await deps.toolTypeIndex?.()?.wireContracts();
        const toolPresenter = deps.toolPresenter?.();
        const toolMap = deps.tools !== undefined
          ? new Map<string, Tool>(deps.tools.list().map(t => {
              const wc = wire?.[t.name];
              return [t.name, wc !== undefined
                ? { ...t, description: wireDescription(t.description, wc) }
                : t];
            }))
          : undefined;

        try {
          // Establish the submitter's principal for the whole turn here, not inside runSession:
          // pump runs detached (`void pump`), so this scope — not the request that enqueued — is the
          // turn's async root. Everything downstream (hooks, tools, and any Store/FileStore/Vault
          // access they trigger) reads it via currentPrincipal(). The consumption MUST happen inside
          // the callback: an async iterator returned out of the scope would lose it before it pulls.
          // contextSwitch (not bare runAs): a turn is the transactional unit, so a StorageBackend swap
          // deferred during it lands at this scope's quiescent edge — never mid-CAS.
          // The terminal event this turn ended on. `followup` is post-COMMIT, and only `done` is a
          // commit: an `aborted` turn was cut short (a steer, a user cancel, a screen/toolcall hook
          // refusing it, a provider round ceiling) and an `error` turn produced no response at all, so
          // in both cases a followup hook would judge history with no completed answer in it — and a
          // `resubmit` would undo the very stop that just happened, handing a round ceiling a fresh
          // budget. Tracked here rather than inferred from `ac.signal`, which only knows about the two
          // signal-driven aborts and not the policy ones.
          let terminal: PipelineEvent['type'] | undefined;
          // One usage scope per pump ITERATION rather than per turn. `followup` is post-commit by
          // definition and a detached classifier settles whenever it settles, so a scope that ended at
          // the turn's commit would drop precisely the spend that is hardest to account for otherwise.
          // The entries array is registered for flush before any work starts, so a late arrival lands
          // in something already tracked and needs no coordination of its own.
          await withUsageScope(async usage => {
          s.pendingUsage.push(usage.entries);
          await contextSwitch(head.principal, async () => {
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
              ...(deps.configPath    !== undefined ? { configPath:    deps.configPath    } : {}),
              ...(deps.vault         !== undefined ? { vault:         deps.vault         } : {}),
              ...(head.prompt        !== undefined ? { prompt:        head.prompt        } : {}),
              ...(inject             !== undefined ? { injectedEphemeral: inject } : {}),
            })) {
              if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') terminal = ev.type;
              emit(s, ev);
            }
          });

          // followup — post-commit, in the queue owner. A hook reads the just-committed turn and may
          // head-enqueue a robo follow-up (its own real turn, running next). Runs only for a turn that
          // committed (see `terminal`), and under the submitter's principal because a reactor may itself
          // call complete() (a classifier).
          const hooks = deps.hooks;
          if (terminal === 'done' && hooks) {
            const committed = await deps.store.get(id);
            if (committed && head.resubmitDepth < MAX_RESUBMIT_DEPTH) {
              let followup: { resubmits: MessageContent[][]; markers: MessageContent[]; retract?: { context: MessageContent[]; durable: MessageContent[] } } = { resubmits: [], markers: [] };
              await contextSwitch(head.principal, async () => {
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
                await deps.store.set(id, {
                  ...committed,
                  messages: [...committed.messages, {
                    id:        crypto.randomUUID(),
                    role:      'marker',
                    createdAt: new Date().toISOString(),
                    traceId:   head.traceId,
                    content:   followup.markers,
                  }],
                });
                notify(s, { type: 'marker', content: followup.markers, traceId: head.traceId });
              }
              // unshift in reverse so the hooks' order is preserved at the head of the queue. Stamp
              // every block `origin: 'robo'` here — once — so it rides into both the live `queued`
              // event and the persisted user message the pump builds from this item.
              for (const raw of resubmits.reverse()) {
                const rt = crypto.randomUUID();
                const content = raw.map(c => (c.type === 'text' ? { ...c, origin: 'robo' as const } : c));
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
                const lastUserIdx = lastUserIndex(committed);
                const popped = lastUserIdx >= 0 ? committed.messages.slice(lastUserIdx + 1) : [];
                // `durable` correction (a contextual fire that landed post-commit) folds onto the user
                // message we keep — persisted, so the redo AND every later turn see it in history, the
                // exact durability the clean in-situ path gives. `context` stays ephemeral (redo only).
                // The fold runs on the *truncated* session, whose last user message is the one we keep,
                // so it goes through the same helper as the screen and raced-verdict folds.
                const durable = followup.retract.durable ?? [];
                const truncated = lastUserIdx >= 0
                  ? { ...committed, messages: committed.messages.slice(0, lastUserIdx + 1) }
                  : committed;
                const kept = foldOntoUserTurn(truncated, durable).messages;
                const retractionMsg: Message = {
                  id:        crypto.randomUUID(),
                  role:      'marker',
                  createdAt: new Date().toISOString(),
                  traceId:   head.traceId,
                  // `retracted` is what was popped (the superseded answer); `injected` is the ephemeral
                  // context fed to the redo — neither is otherwise persisted, so the pair fully traces
                  // the swap for a post-mortem (and a frontend can render the strike-through + the cause).
                  content:   [{ type: 'marker', creator: RETRACTION_CREATOR, data: { retracted: popped, injected: followup.retract.context ?? [], traceId: head.traceId } }],
                };
                // Any followup markers ride along as a trailing marker message (not folded into the
                // retraction marker) so each creator's trace stays its own block.
                const trailing: Message[] = followup.markers.length > 0
                  ? [{ id: crypto.randomUUID(), role: 'marker', createdAt: new Date().toISOString(), traceId: head.traceId, content: followup.markers }]
                  : [];
                await deps.store.set(id, { ...committed, messages: [...kept, retractionMsg, ...trailing] });
                // Emit the durable fold live (as a robo-user on the kept user turn) before the retraction
                // marker, mirroring the screen-time durable path's ordering.
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
                  redo:          { ephemeral: followup.retract.context ?? [] },
                  ...(head.prompt !== undefined ? { prompt: head.prompt } : {}),
                });
              }
            }
          }
          }, head.traceId);
        } catch (e) {
          emit(s, { type: 'error', error: String(e), traceId: head.traceId });
        } finally {
          s.ac = undefined;
        }
      }
    } finally {
      s.running = false;
      s.runningTraceId = undefined;
      s.replay  = [];
      // Accounting is flushed HERE — at the drained queue, not at a turn boundary. "The end of a turn"
      // is not a well-defined moment to total anything at: steers terminate and resume, a retract
      // re-enqueues the turn it just popped, followup enqueues resubmissions, and a detached classifier
      // settles whenever it settles. The queue draining is unambiguous, and it is after all of them.
      await flushUsage(id, s);
      // Deterministic busy→idle signal: running is now false, so any subscriber draining the stream
      // (a frontend's status tracker) reads an authoritative idle the moment it sees this — no racing
      // the microtask on which `running` flipped. Not in `replay` (transient lifecycle, not history).
      notify(s, { type: 'idle', sessionId: id });
      maybeCleanup(id, s);
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
        const { content, provider, principal } = opts;
        const mode = opts.mode ?? 'queue';

        // Decide interrupt vs queue for a submission arriving mid-turn. Steering is only meaningful
        // while a turn is running; with nothing running it enqueues and runs next regardless of mode.
        // The decision — and, on interrupt, the abort+unshift — happen here synchronously against
        // s.running (re-checked after any classify/nudge await) so an interrupt can never land on the
        // wrong (a later) turn: the fatal race of deciding across a wire is closed by deciding in-runner.
        let interrupt = false;
        if (mode !== 'queue' && s.running) {
          const policy = deps.steeringPolicy?.();
          // Fetch the committed session once (history up to the running turn's start) only when a policy
          // member actually needs it: classify under `auto`, and nudge on any interrupt. The common
          // no-policy interrupt path (e.g. the web default) does no extra read.
          const wantClassify = mode === 'auto' && policy?.classify !== undefined;
          const wantNudge    = policy?.nudge !== undefined;
          const committed = (wantClassify || wantNudge) ? await deps.store.get(opts.sessionId) : null;

          const decision: SteeringDecision = mode === 'interrupt'
            ? 'interrupt'
            : policy?.classify !== undefined
              ? (committed ? await policy.classify({ session: committed, steer: content }) : DEFAULT_STEERING_POLICY)
              : DEFAULT_STEERING_POLICY;

          // Any await above may have outlived the running turn; only interrupt one still live.
          if (decision === 'interrupt' && s.running) {
            const nudge = policy?.nudge !== undefined && committed
              ? policy.nudge({ session: committed, steer: content })
              : DEFAULT_STEER_NUDGE;
            const interruptedTraceId = s.runningTraceId ?? '';
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
            interrupt = true;
          }
        }

        if (!interrupt) {
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
            // Replay the in-progress turn, then the pending queue — the delta region, in order.
            for (const ev of st.replay) sink.push(ev);
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
    },

    cancelTurn(sessionId: string): void {
      const s = states.get(sessionId);
      if (s === undefined) return;
      // Deliberately no queue splice: cancel abandons only the running turn; queued submissions are
      // separate operations the user lined up and survive into the next `pump` iteration.
      s.ac?.abort('user-cancel');
    },

    status(sessionId: string): { busy: boolean; running: boolean; queued: number } {
      const s = states.get(sessionId);
      const running = s?.running ?? false;
      const queued  = s?.queue.length ?? 0;
      return { busy: running || queued > 0, running, queued };
    },
  };
}
