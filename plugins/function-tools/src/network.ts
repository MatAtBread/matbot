import { originGatedFetch, refusalMessage } from '@matatbread/matbot-plugin-api';
import type { ToolContext } from '@matatbread/matbot-plugin-api';

/** Who is asking, as {@link gatedNetwork} words and files it: the gate's namespace, the function's part of
 *  the subject, and the function as prose. */
export interface Asker { namespace: string; fn: string; who: string }

const NETWORK = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * The `fetch` and `WebSocket` a body is handed in place of the platform's: each origin it reaches is one
 * {@link PermissionGate} decision per function, as each module it imports is. A body that can fetch can send
 * anything it has read to anywhere, so where is the question — and the ORIGIN, scheme, host and port
 * exactly, because `http:` and another port are other servers, and a prefix would let `api.x` admit
 * `api.x.evil`. A redirect is a new request, asked about in its own right ({@link originGatedFetch}).
 *
 * A `data:` or `blob:` URL reaches no network and is not asked about.
 *
 * One decision per origin per invocation, as for an import: a body polling in a loop would otherwise ask on
 * every pass, and a refused one re-prompt on every pass.
 */
export function gatedNetwork(ctx: ToolContext, asker: Asker): { fetch: typeof fetch; WebSocket: typeof WebSocket } {
  const decided = new Map<string, Promise<void>>();
  const admit = async (url: URL): Promise<void> => {
    if (!NETWORK.has(url.protocol)) return;
    let decision = decided.get(url.origin);
    if (decision === undefined) {
      decision = decide(ctx, asker, url.origin);
      decided.set(url.origin, decision);
    }
    await decision;
  };
  return {
    fetch: ((input, init) => originGatedFetch(admit, input, init)) as typeof fetch,
    WebSocket: gatedWebSocket(admit),
  };
}

async function decide(ctx: ToolContext, { namespace, fn, who }: Asker, origin: string): Promise<void> {
  const permit = await ctx.gate({
    namespace, gate: 'connect', subject: `${fn} ${origin}`, fallback: false,
    label: `Allow ${who} to connect to **${origin}**? It can send there anything it can read.`,
    standing: [
      { subject: `${fn} ${origin}`, label: `Always allow ${who} to connect to ${origin}` },
      { subject: `* ${origin}`,     label: `Always allow ANY function to connect to ${origin}` },
    ],
  });
  if (!permit.allowed) throw new Error(refusalMessage(permit, `Connecting to ${origin}`));
}

/**
 * A `WebSocket` that asks before it opens. The constructor is synchronous and a decision is not, so this is
 * a stand-in rather than the real thing: it is `CONNECTING` while the gate decides, then forwards to a real
 * socket, re-dispatching each event as its own. A refusal fails the connection as a network error would —
 * `error`, then `close` with code 1006 — with the refusal as the close `reason`, the one field a body
 * listening for the failure will read.
 */
function gatedWebSocket(admit: (url: URL) => Promise<void>): typeof WebSocket {
  const Real = globalThis.WebSocket;
  type Handler = ((ev: Event) => unknown) | null;

  class GatedWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN       = 1;
    static readonly CLOSING    = 2;
    static readonly CLOSED     = 3;
    readonly CONNECTING = 0;
    readonly OPEN       = 1;
    readonly CLOSING    = 2;
    readonly CLOSED     = 3;
    readonly url: string;
    onopen: Handler = null;
    onmessage: Handler = null;
    onerror: Handler = null;
    onclose: Handler = null;
    #real: WebSocket | undefined;
    #state = 0;
    #binaryType: BinaryType = 'blob';

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const target = new URL(url);
      if (target.protocol === 'http:')  target.protocol = 'ws:';
      if (target.protocol === 'https:') target.protocol = 'wss:';
      this.url = target.href;
      admit(target).then(() => {
        if (this.#state !== 0) return;
        const real = new Real(target, protocols);
        real.binaryType = this.#binaryType;
        this.#real = real;
        real.addEventListener('open',    () => this.#emit(new Event('open')));
        real.addEventListener('message', ev => this.#emit(new MessageEvent('message', { data: ev.data, origin: ev.origin })));
        real.addEventListener('error',   () => this.#emit(new Event('error')));
        real.addEventListener('close',   ev => this.#emit(new CloseEvent('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean })));
      }, (e: unknown) => {
        if (this.#state !== 0) return;
        this.#state = 3;
        this.#emit(new Event('error'));
        this.#emit(new CloseEvent('close', { code: 1006, reason: e instanceof Error ? e.message : String(e), wasClean: false }));
      });
    }

    get readyState(): number { return this.#real?.readyState ?? this.#state; }
    get protocol(): string { return this.#real?.protocol ?? ''; }
    get extensions(): string { return this.#real?.extensions ?? ''; }
    get bufferedAmount(): number { return this.#real?.bufferedAmount ?? 0; }
    get binaryType(): BinaryType { return this.#real?.binaryType ?? this.#binaryType; }
    set binaryType(t: BinaryType) { this.#binaryType = t; if (this.#real) this.#real.binaryType = t; }

    send(data: Parameters<WebSocket['send']>[0]): void {
      if (this.#real === undefined) throw new DOMException('WebSocket is not open.', 'InvalidStateError');
      this.#real.send(data);
    }

    close(code?: number, reason?: string): void {
      if (this.#real !== undefined) { this.#real.close(code, reason); return; }
      if (this.#state !== 0) return;
      this.#state = 3;
      this.#emit(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
    }

    #emit(ev: Event): void {
      const handlers: Record<string, Handler> = { open: this.onopen, message: this.onmessage, error: this.onerror, close: this.onclose };
      handlers[ev.type]?.call(this, ev);
      this.dispatchEvent(ev);
    }
  }
  return GatedWebSocket as unknown as typeof WebSocket;
}
