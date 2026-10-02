import type { AppendMessage, AppendResult, NotifyInput, Principal } from '@matatbread/matbot-plugin-api';
import { ItemChangeKind } from '@matatbread/matbot-plugin-api';
import type { JobInfo } from '@matatbread/matbot-background-jobs';
export type { JobInfo };

// The protocol between a job and the process that spawned it, over Node's IPC channel. A job shares
// its parent's storage medium but none of its parent's turns, so it must not write a session itself;
// it asks. The channel is per child, so who is asking needs no token: the parent knows which job it
// spawned on the other end.


/** Job → parent. A request carries `rid` and is answered; a `notify` is fire-and-forget. */
export type ChildMessage =
  | { op: 'job';    rid: number }
  | { op: 'append'; rid: number; sessionId?: string; messages: AppendMessage[] }
  | { op: 'notify'; notification: unknown };

/** Parent → job: the answer to one request. */
export type ParentMessage =
  | { rid: number; ok: true;  value: unknown }
  | { rid: number; ok: false; error: string };

/** One end of the channel as far as this protocol uses it: the `ChildProcess` on the parent's side,
 *  `process` on the job's. Narrowed so a test can drive both ends without spawning anything. */
export interface Endpoint {
  send(message: unknown, callback: (error: Error | null) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface JobHandlers {
  info(): Promise<JobInfo>;
  append(sessionId: string | undefined, messages: AppendMessage[]): Promise<AppendResult>;
  notify(notification: unknown): void;
}

const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** The parent's side: answer one job's requests for as long as its channel is open. */
export function serveJob(child: Endpoint, handlers: JobHandlers): void {
  // A reply to a job that has already gone has nowhere to go, and that is not this side's failure.
  const reply = (message: ParentMessage): void => { try { child.send(message, () => {}); } catch { /* gone */ } };
  child.on('message', raw => {
    // A job is a separate program: what arrives is checked here, at the boundary, not trusted.
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as { op?: unknown; rid?: unknown; sessionId?: unknown; messages?: unknown; notification?: unknown };
    if (msg.op === 'notify') { handlers.notify(msg.notification); return; }
    if (typeof msg.rid !== 'number') return;
    const rid = msg.rid;
    const answer = (work: Promise<unknown>): void => {
      work.then(value => reply({ rid, ok: true, value }), (e: unknown) => reply({ rid, ok: false, error: errorText(e) }));
    };
    switch (msg.op) {
      case 'job':
        answer(handlers.info());
        return;
      case 'append': {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
        answer(Promise.resolve().then(() => handlers.append(sessionId, jobText(msg.messages))));
        return;
      }
      default:
        reply({ rid, ok: false, error: `Unknown request "${String(msg.op)}".` });
    }
  });
}

// What a job may say: assistant text and nothing else. It speaks for itself — never as the user, and
// never with metadata of its own, which the parent supplies.
function jobText(raw: unknown): AppendMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Nothing to append.');
  return raw.map((m: unknown) => {
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'assistant') throw new Error('A background job may append only assistant messages.');
    if (!Array.isArray(msg.content) || msg.content.length === 0) throw new Error('An appended message needs content.');
    return {
      role:    'assistant',
      content: msg.content.map((c: unknown) => {
        const block = c as { type?: unknown; text?: unknown };
        if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('An appended message may carry text only.');
        return { type: 'text' as const, text: block.text, origin: 'robo' as const };
      }),
    };
  });
}

export interface ParentLink {
  request<T>(message: { op: 'job' } | { op: 'append'; sessionId?: string; messages: AppendMessage[] }): Promise<T>;
  /** Fire-and-forget. Tracked, so {@link flush} can wait for it before the job exits. */
  post(message: { op: 'notify'; notification: unknown }): void;
  /** Settles once every {@link post} has been handed to the channel (or failed). */
  flush(): Promise<void>;
  /** The channel is gone: fail whatever is still waiting on an answer. */
  close(reason: string): void;
}

/** A channel's handle (`process.channel`): whether it keeps the event loop alive. */
export interface Holdable { ref(): void; unref(): void }

/**
 * The job's side.
 *
 * The channel is held exactly while something is outstanding — an answer awaited, a send not yet
 * handed over — and released otherwise. Released for good, a job waiting on its parent's answer has
 * nothing keeping it alive and exits mid-request (measured: "unsettled top-level await", exit 13); held
 * for good, a job whose turn has ended never exits at all.
 */
export function connectToParent(parent: Endpoint, handle?: Holdable): ParentLink {
  let next = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const inFlight = new Set<Promise<void>>();
  let closed: string | undefined;
  let outstanding = 0;
  const hold    = (): void => { if (outstanding++ === 0) handle?.ref(); };
  const release = (): void => { if (outstanding > 0 && --outstanding === 0) handle?.unref(); };
  handle?.unref();

  parent.on('message', raw => {
    const msg = raw as Partial<ParentMessage>;
    if (typeof msg.rid !== 'number') return;
    const w = waiting.get(msg.rid);
    if (!w) return;
    waiting.delete(msg.rid);
    if (msg.ok === true) w.resolve((msg as { value: unknown }).value);
    else w.reject(new Error((msg as { error?: string }).error ?? 'The parent refused the request.'));
  });

  // `send` on a closed channel reports through its callback rather than throwing — and returns false,
  // which is NOT a capability check: the callback is the only honest answer.
  const send = (message: ChildMessage): Promise<void> => new Promise((resolve, reject) => {
    if (closed !== undefined) { reject(new Error(closed)); return; }
    try { parent.send(message, err => (err ? reject(err) : resolve())); }
    catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
  });

  return {
    request<T>(message: { op: 'job' } | { op: 'append'; sessionId?: string; messages: AppendMessage[] }): Promise<T> {
      const rid = ++next;
      hold();
      const answered = new Promise<T>((resolve, reject) => {
        waiting.set(rid, { resolve: v => resolve(v as T), reject });
        send({ ...message, rid } as ChildMessage).catch((e: unknown) => {
          waiting.delete(rid);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
      void answered.then(release, release);
      return answered;
    },
    post(message) {
      hold();
      const sent = send(message).catch(() => { /* a lost announcement is a stale panel, not an error */ });
      inFlight.add(sent);
      void sent.finally(() => { inFlight.delete(sent); release(); });
    },
    async flush() {
      await Promise.allSettled([...inFlight]);
    },
    close(reason) {
      closed = reason;
      for (const w of waiting.values()) w.reject(new Error(reason));
      waiting.clear();
    },
  };
}

/**
 * A job's announcement, as the parent may republish it — or `undefined` if it may not.
 *
 * Only `ItemChange` crosses: "the item at (namespace, id) changed", which holds for the parent too, since
 * the job wrote the store they share. A registry change describes the JOB's own process — every job
 * registers its tools at boot — and relayed it would rebuild the parent's type index and tool search on
 * every spawn. Any other kind has no known meaning outside the job. One already carrying an `instance`
 * was relayed once; passing it on again is the loop that field exists to break.
 */
export function relayable(raw: unknown, instance: string): NotifyInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const n = raw as Record<string, unknown>;
  if (n['kind'] !== ItemChangeKind || n['instance'] !== undefined) return undefined;
  const { plugin, source, namespace, id, operation, key, detail, principal } = n;
  if (typeof plugin !== 'string' || typeof source !== 'string' || typeof namespace !== 'string' || typeof id !== 'string') return undefined;
  if (operation !== 'saved' && operation !== 'deleted') return undefined;
  return {
    kind: ItemChangeKind, plugin, source, namespace, id, operation, instance,
    ...(typeof key === 'string' ? { key } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(isPrincipal(principal) ? { principal } : {}),
  };
}

function isPrincipal(v: unknown): v is Principal {
  return typeof v === 'object' && v !== null
    && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { type?: unknown }).type === 'string';
}
