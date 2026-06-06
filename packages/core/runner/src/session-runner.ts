import type {
  Session, Message, MessageContent, Principal, PromptFn, PipelineEvent,
  Store, ToolRegistry, SystemContextRegistry, Vault, FileStore, Tool,
  ProviderAdapter, ProviderConfig, SessionRunner, SessionView, OpenOpts, SubmitOpenOpts,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';
import { runSession } from './runner.js';

export interface SessionRunnerDeps {
  store:           Store<Session>;
  resolveProvider: (name: string) => Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null>;
  tools?:          ToolRegistry;
  hooks?:          HookRegistry;
  systemContext?:  SystemContextRegistry;
  vault?:          Vault;
  files?:          FileStore;
  workdir?:        string;
  configPath?:     string;
  loadPlugin:      (specifier: string, prompt?: PromptFn) => Promise<MatbotPlugin>;
  unloadPlugin:    (specifier: string) => Promise<boolean>;
}

interface QueuedItem {
  traceId:     string;
  content:     MessageContent[];
  provider:    string;
  principal:   Principal;
  concatQueue: boolean;
  prompt?:     PromptFn;
}

interface SessionState {
  // The queue is deliberately a plain array, drained FIFO. Default (queue mode): each submission
  // becomes its own turn — faithful, and correct when one submission's tools/state are a
  // precondition for the next (e.g. "add plugin X" then "use X": tools are rebuilt per turn, so X
  // is only visible to a *later* turn). When a drained item has concatQueue set, the whole pending
  // batch is merged into one turn instead — cheaper, but it collapses distinct asks and is meant
  // as a per-frontend policy, not mixed per-call.
  queue:       QueuedItem[];
  running:     boolean;
  ac:          AbortController | undefined;
  subscribers: Set<Sink>;
  // Events of the *current* turn, replayed to a subscriber that joins mid-turn. Cleared at each
  // turn boundary — committed history comes from the store, not from here.
  replay:      PipelineEvent[];
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

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  const states = new Map<string, SessionState>();

  const stateFor = (id: string): SessionState => {
    let s = states.get(id);
    if (s === undefined) {
      s = { queue: [], running: false, ac: undefined, subscribers: new Set(), replay: [] };
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

  const pump = async (id: string, s: SessionState): Promise<void> => {
    if (s.running) return;
    s.running = true;
    try {
      while (s.queue.length > 0) {
        const head  = s.queue[0]!;
        const batch = head.concatQueue ? s.queue.splice(0) : [s.queue.shift()!];
        const content = batch.flatMap(i => i.content);
        s.replay = [];

        let session = await deps.store.get(id);
        if (session === null) {
          emit(s, { type: 'error', error: `Session "${id}" not found`, traceId: head.traceId });
          continue;
        }

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
        // while queued. That is what stops a mid-turn submit from clobbering session state.
        session = appendMessage(session, createMessage({ role: 'user', content, traceId: head.traceId }));
        await deps.store.set(session.id, session);

        const resolved = await deps.resolveProvider(head.provider);
        if (resolved === null) {
          emit(s, { type: 'error', error: `Unknown provider "${head.provider}"`, traceId: head.traceId });
          continue;
        }

        const ac = new AbortController();
        s.ac = ac;
        const toolMap = deps.tools !== undefined
          ? new Map<string, Tool>(deps.tools.list().map(t => [t.name, t]))
          : undefined;

        try {
          for await (const ev of runSession({
            session,
            config:         { principal: head.principal, provider: head.provider, traceId: head.traceId },
            provider:       resolved.adapter,
            providerConfig: resolved.config,
            store:          deps.store,
            signal:         ac.signal,
            loadPlugin:     deps.loadPlugin,
            unloadPlugin:   deps.unloadPlugin,
            ...(toolMap            !== undefined ? { tools:         toolMap            } : {}),
            ...(deps.hooks         !== undefined ? { hooks:         deps.hooks         } : {}),
            ...(deps.systemContext !== undefined ? { systemContext: deps.systemContext } : {}),
            ...(deps.workdir       !== undefined ? { workdir:       deps.workdir       } : {}),
            ...(deps.files         !== undefined ? { files:         deps.files         } : {}),
            ...(deps.configPath    !== undefined ? { configPath:    deps.configPath    } : {}),
            ...(deps.vault         !== undefined ? { vault:         deps.vault         } : {}),
            ...(head.prompt        !== undefined ? { prompt:        head.prompt        } : {}),
          })) {
            emit(s, ev);
          }
        } catch (e) {
          emit(s, { type: 'error', error: String(e), traceId: head.traceId });
        } finally {
          s.ac = undefined;
        }
      }
    } finally {
      s.running = false;
      s.replay  = [];
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
        s.queue.push({
          traceId,
          content:     opts.content,
          provider:    opts.provider,
          principal:   opts.principal,
          concatQueue: opts.concatQueue ?? false,
          ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
        });
        // Announce the submission on the stream as part of the live delta, before its turn's events.
        // If it runs immediately `queued` is 0 (no wait); otherwise it's how many are ahead.
        notify(s, { type: 'queued', content: opts.content, queued: aheadOf(s, s.queue.length - 1), traceId });
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
              sink.push({ type: 'queued', content: item.content, queued: aheadOf(st, i), traceId: item.traceId }));
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
      s.ac?.abort();
    },

    status(sessionId: string): { busy: boolean; running: boolean; queued: number } {
      const s = states.get(sessionId);
      const running = s?.running ?? false;
      const queued  = s?.queue.length ?? 0;
      return { busy: running || queued > 0, running, queued };
    },
  };
}
