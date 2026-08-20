import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MatbotPlugin, Principal, Session, Store, Tool, ToolRegistry, FileStore, Vault,
  FormField, PromptFn, SessionRunner, WatchVisibility, VisibilityQuery, FilePartition, SteeringMode,
  Notifier, Notification,
} from '@matatbread/matbot-core';
import { createSession, promptCancelledError, runAs, tryCurrentPrincipal, ItemChangeKind, RegistryChangeKind } from '@matatbread/matbot-core';
import { sseComment, sseEvent } from './sse-writer.js';
import { makeWebEnvTool } from './web-env.js';
import { promises } from "node:fs";
const { readFile } = promises;

export interface WebServerDeps {
  store:          Store<Session>;
  /** Per-session turn serialiser — submits queue instead of running concurrently. */
  run:            SessionRunner;
  vault:          Vault;
  loadPlugin:     (specifier: string) => Promise<MatbotPlugin>;
  unloadPlugin:   (specifier: string) => Promise<boolean>;
  tools?:         ToolRegistry;
  cors?:          string;  // Access-Control-Allow-Origin value, default '*'
  workdir?:       string;
  files?:         FileStore;
  /** Optional partition-aware file-watch layer. Resolved lazily (a thunk, not a captured value) because a
   *  partitioning storage backend may register it *after* frontend-web sets up — capturing a value here
   *  would snapshot `undefined` and silently fall back to base-only watching. When present, the firehose
   *  observes file events across every partition (origin-stamped) and filters each SSE connection by its
   *  principal; absent ⇒ the plain single-stream `files.watch()` with no filter (the non-partitioned default). */
  watchVisibility?: () => WatchVisibility | undefined;
  /** Optional file-area addressing, from the same partitioning backend and lazily for the same reason:
   *  resolves the `~<partition>` segment of a `GET /files/` URL back to the area those bytes were written
   *  to. Absent ⇒ one undivided file area, and the segment (if any) is moot. */
  filePartition?: () => FilePartition | undefined;
  /** The notification bus this frontend both publishes to (a session created over HTTP) and subscribes
   *  to (the firehose). */
  notifier:       Notifier;
  configPath?:    string;
  /** Derives the security principal for each request. Defaults to {@link defaultWebPrincipal}. */
  resolvePrincipal?: WebPrincipalResolver;
  /** How often to write a keep-alive comment on each SSE stream, in ms. Default 20s — comfortably inside
   *  the 60s that proxies and load balancers commonly idle a quiet connection out at. Lower it behind a
   *  more aggressive intermediary; it is not a tuning knob for anything else, and in particular do not
   *  RAISE it past ~21s: the bundled client's idle watchdog gives up after 65s of total silence, so a
   *  slower beat would have it tear down and reconnect a stream that is perfectly healthy. */
  heartbeatMs?:   number;
}

/**
 * Derives the security principal for an incoming HTTP request. The default ({@link defaultWebPrincipal})
 * returns one constant placeholder; a plugin can register its own under `services.WebPrincipalResolver` to
 * derive a real identity from the request — typically auth headers. It is resolved once at the
 * request entry and established ambiently via `runAs()` for the whole request, so every downstream
 * store/file/vault access (and the submitted turn) reads it via `currentPrincipal()`.
 */
export type WebPrincipalResolver = (req: IncomingMessage) => Principal | Promise<Principal>;

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** Registered by @matatbread/matbot-frontend-web: derive the per-request principal (default: a constant placeholder). */
    WebPrincipalResolver?: WebPrincipalResolver;
  }
}

interface SubmitBody {
  content:      string | { type: 'form-response'; values: Record<string, string> };
  provider:     string;       // opaque name passed to deps.resolveProvider
  sessionId?:   string;
  traceId?:     string;
  concatQueue?: boolean;      // true (default): merge into the running turn's batch; false: own turn
  mode?:        SteeringMode; // disposition for a mid-turn submit; default 'auto' (see SteeringPolicy)
}

// Last-resort anonymous identity, used only when no boot principal is established and no resolver
// override is registered (e.g. tests, or a realm with no carrier).
const ANONYMOUS_WEB_USER: Principal = {
  id:   'web-user',
  type: 'user',
};

// A generic per-request identity hint: an `x-matbot-principal` header names the identity this browser is
// acting as (type 'user'), or undefined when absent. The frontend learns only "identity header," never
// any particular feature's notion of it — whatever backend/service interprets the principal does the
// rest (e.g. the profile selector stores its choice locally and sends it here). It takes precedence over
// a registered WebPrincipalResolver (see the composition in plugin.ts), so an explicitly-asserted
// identity is an override, not something a resolver can shadow. There is no auth here by design.
export function headerPrincipal(req: IncomingMessage): Principal | undefined {
  const hinted = req.headers['x-matbot-principal'];
  const id     = (Array.isArray(hinted) ? hinted[0] : hinted)?.trim();
  return id ? { id, type: 'user' } : undefined;
}

// The same identity hint carried in the URL as `?principal=<id>`, for a request that cannot set a header —
// notably an `EventSource` (SSE), whose browser API has no header option. The global `/events` firehose now
// carries per-connection-filtered file events, so its EventSource passes the chosen profile this way. Ranked
// below the header (an explicit XHR header still wins) and, like it, is routing not auth — client-asserted.
export function urlPrincipal(req: IncomingMessage): Principal | undefined {
  const q = req.url?.indexOf('?') ?? -1;
  if (q < 0) return undefined;
  const id = new URLSearchParams(req.url!.slice(q + 1)).get('principal')?.trim();
  return id ? { id, type: 'user' } : undefined;
}

// The default request identity when no header and no override resolver apply: the process boot principal
// (the pod/sandbox/system identity established at the entry), keeping web sessions attributed to the same
// identity as the rest of the app. The header still wins here too, for when this default is used directly.
export const defaultWebPrincipal: WebPrincipalResolver = (req) =>
  headerPrincipal(req) ?? urlPrincipal(req) ?? tryCurrentPrincipal() ?? ANONYMOUS_WEB_USER;

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) { reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type':   'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    // Without this a cross-origin page cannot read the version header at all (it isn't CORS-safelisted),
    // so the client's staleness check would silently never fire.
    'access-control-expose-headers': 'x-matbot-version',
  };
}

// The single interactive prompt implementation is the SSE round-trip built per-submit (see the
// `/sessions/:id/submit` handler): it parks on `pendingPrompts` and is answered via
// `POST /sessions/:id/prompt`. The direct tool-invocation endpoints (`/tools/:name`,
// `/stream/tools/:name`) have no session and no answer channel, so they CANNOT prompt
// interactively — a known, deliberate blind spot. Any UI flow that needs to ask the user
// something must drive the tool through `/submit` instead. This fallback makes that boundary
// explicit: take the default if one was offered, otherwise fail loudly rather than hang.
const nonInteractivePrompt: PromptFn = ((p: string | FormField, def?: string) => {
  const fallback = typeof p === 'string' ? def : p.default;
  return fallback !== undefined
    ? Promise.resolve(fallback)
    : Promise.reject(new Error(`Non-interactive context (use /submit for interactive prompts): "${typeof p === 'string' ? p : p.label}"`));
}) as PromptFn;

export function createWebServer(deps: WebServerDeps) {
  const origin = deps.cors ?? '*';
  const resolvePrincipal = deps.resolvePrincipal ?? defaultWebPrincipal;

  // Boot race guard for the /tools endpoints. This server starts listening inside frontend-web's
  // setup(), which runs before the plugins configured after it — and before the core tools registered
  // once loading finishes — have populated the tool registry. So a tool call arriving during boot can
  // outrun its tool's registration (the UI's bootstrap fires several: session_action, provider,
  // about_matbot, skill_action…), and a plain resolve() would 404 a tool that is merely late. Within a
  // grace window from server start we wait for the name to register instead; after it, an unknown name
  // is a genuine 404 returned at once, so a bad name never hangs. Measured from server construction
  // (== frontend-web setup == boot start); 30s comfortably covers a slow/cold boot.
  const BOOT_TOOL_GRACE_MS = 30_000;
  const bootGraceUntil = Date.now() + BOOT_TOOL_GRACE_MS;

  // ...but the ceiling is not the wait. A name that will NEVER register — the UI probing for an optional
  // capability, `profile_action` when the profiles backend is not configured — used to park for the whole
  // remaining window and then 404, because the grace expired on a CLOCK rather than on the thing it was
  // actually waiting for. It waited out 30 seconds even when every plugin had loaded and the registry was
  // final seconds earlier; there was simply no signal saying so.
  //
  // The tool registry going quiet IS that signal. Boot registers tools in a dense burst (each plugin's
  // setup(), then core's own), so a gap this long means the burst is over and an unknown name is genuinely
  // unknown. A heuristic, deliberately: "loading has finished" is not a fact this plugin can be told, and
  // inventing a notification for it would put a boot-sequencing concern into core to save a frontend a
  // couple of seconds. Generous enough to sit well clear of a slow plugin import, and the 30s ceiling still
  // backstops the case where it guesses wrong.
  const TOOL_REGISTRY_QUIET_MS = 2_500;
  let lastToolChangeAt = Date.now();

  // Persistent per-session event subscribers (the GET /events/sessions/:id SSE streams). Submits are
  // fire-and-forget — all turn output, and interactive prompts, reach clients over these. Holding one
  // connection per session (not per submission) is what keeps queued submits off the browser's
  // ~6-socket-per-host limit, which otherwise starved both the `queued` signal and POST /prompt.
  const sessionConns = new Map<string, Set<ServerResponse>>();
  const busyState    = new Map<string, boolean>();                     // last-broadcast busy per session
  // Sessions with a live server-owned busy tracker (see the submit handler). One transient tracker
  // per busy period drives the idle broadcast independently of any client events stream.
  const busyTrackers = new Set<string>();
  // session ID → the parked prompt. `resolve` delivers an answer (applying the default fallback);
  // `cancel` rejects it with PromptCancelledError — the "give up" path.
  //
  // `event` is the serialised `prompt` frame, kept so the prompt can be RE-SENT to a stream that
  // arrives later. Raising a prompt is one fire-and-forget write, and a stream can be absent (the user
  // is on another conversation) or dead-but-unreaped; either way the write reached nobody, nothing
  // replayed it, and the turn parked forever with no prompt anywhere on screen. The prompt is state,
  // not an event: it stays true until answered, so every new viewer of the session is told about it.
  const pendingPrompts = new Map<string, { resolve: (answer: string) => void; cancel: () => void; event: string }>();

  // Neither end of an SSE stream can tell quiet from dead without traffic on it. A socket killed by
  // sleep, a network change, a proxy's idle timeout or a frozen background tab stays `writable` here
  // and pending in the client's `reader.read()` — so the server never reaps it (and goes on reporting
  // successful writes into it) while the client never errors, so never reconnects. A periodic comment
  // fixes both: the write eventually fails and closes this connection, and the client's own idle
  // watchdog fires. Well inside the 60s that proxies and load balancers typically idle out at.
  const HEARTBEAT_MS = deps.heartbeatMs ?? 20_000;
  const heartbeat = (res: ServerResponse): () => void => {
    const timer = setInterval(() => {
      if (res.writable) res.write(sseComment('hb'));
      else clearInterval(timer);
    }, HEARTBEAT_MS);
    // A heartbeat must never be the reason the process stays up.
    timer.unref();
    return () => clearInterval(timer);
  };
  // call ID → settlers for an in-flight web_user_environment round-trip. Keyed by the tool call's
  // `callId` (not session id) because a turn can issue parallel tool calls; the answer arrives via
  // POST /sessions/:id/env-result carrying that callId. See evalInBrowser below.
  const pendingEvalCalls = new Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>();

  // One multiplexed event stream (GET /events) carries every global, non-session event — session
  // busy/idle, file changes, and tool/skill/plugin CRUD — each tagged by name and demuxed client-side.
  // Browsers cap HTTP/1.1 at ~6 sockets per host; a separate SSE connection per panel would exhaust
  // that and starve ordinary fetches (the sidebar load, tool calls), so the whole UI shares one socket.
  // Each listener carries its connection's principal, so file events can be filtered per connection when
  // storage partitions them (see the WatchVisibility path below). Non-partitioned deployments ignore it.
  const globalListeners = new Map<ServerResponse, Principal>();

  const broadcast = (msg: string, visible?: (principal: Principal) => boolean): void => {
    for (const [res, principal] of globalListeners) {
      if (visible !== undefined && !visible(principal)) continue;
      if (res.writable) res.write(msg); else globalListeners.delete(res);
    }
  };

  const watchAc = new AbortController();

  // The tool-registry activity clock behind TOOL_REGISTRY_QUIET_MS. Subscribed here rather than inside
  // startFirehose, which is deliberately lazy: a /tools call can (and at boot does) arrive before any
  // client opens an event stream, which is exactly when this needs to have been counting.
  deps.notifier.consume(
    () => { lastToolChangeAt = Date.now(); },
    watchAc.signal,
    n => n.kind === RegistryChangeKind && n.registry === 'tools',
  );

  // ── The firehose ────────────────────────────────────────────────────────────
  //
  // ONE subscription to the notification bus feeds every global SSE listener. Producers publish onto
  // the bus from wherever the change actually happens (a skill saved mid-turn, a session minted over
  // HTTP, a share landing in another profile); this frontend is purely a sink, with exactly one path
  // from "something changed" to a connected browser.
  //
  // Filtering is per (connection × notification), and the registered predicate decides EVERY kind — this
  // used to gate on `kind === ItemChangeKind && principal !== undefined` and consult the predicate only
  // then, which meant every plugin-defined kind was fanned out to every browser with no hook able to stop
  // it. Harmless for the in-process bus (one process, one user); wrong the moment a distributed Notifier
  // bridges an addressed fact in from another instance. So the gate is gone and the judgement moved behind
  // the interface: this frontend hands over everything it knows and takes no position on policy. A
  // partitioning backend's predicate fails open on what it cannot route, so the filtered set is unchanged.
  let firehoseStarted = false;
  function startFirehose(): void {
    if (firehoseStarted) return;
    firehoseStarted = true;
    // Resolved on first connect, not at construction: a partitioning backend may register
    // WatchVisibility *after* frontend-web sets up, and snapshotting undefined would silently
    // downgrade every connection to unfiltered.
    const wv = deps.watchVisibility?.();
    const visibleTo = (n: Notification): ((principal: Principal) => boolean) | undefined => {
      if (wv === undefined) return undefined;
      // Built once per notification, not per connection: `broadcast` iterates every listener, and only
      // `viewer` varies across them. `namespace`/`id` exist on an ItemChange and nowhere else.
      const q: Omit<VisibilityQuery, 'viewer'> = {
        kind: n.kind,
        ...(n.kind === ItemChangeKind    ? { namespace: n.namespace, id: n.id } : {}),
        ...(n.principal !== undefined    ? { origin: n.principal }              : {}),
      };
      return viewer => wv.visible({ viewer, ...q });
    };

    deps.notifier.consume(n => broadcast(sseEvent('notification', n), visibleTo(n)), watchAc.signal);
  }

  function sendToSession(sessionId: string, msg: string): void {
    const conns = sessionConns.get(sessionId);
    if (conns === undefined) return;
    for (const res of conns) { if (res.writable) res.write(msg); else conns.delete(res); }
  }

  // Round-trip the `web_user_environment` tool to the session's attached browser: push the expression
  // down the session's SSE stream, park the settlers on pendingEvalCalls, and resolve when the client
  // POSTs back to /sessions/:id/env-result. Fails fast with no browser attached, and backstops a hung
  // or disconnected client with a timeout (the client runs its own, shorter, Worker timeout too).
  const EVAL_TIMEOUT_MS = 10_000;
  function evalInBrowser(sessionId: string, callId: string, expression: string, signal: AbortSignal): Promise<unknown> {
    const conns = sessionConns.get(sessionId);
    if (!conns || conns.size === 0) {
      return Promise.reject(new Error('No browser is attached to this session, so the user environment cannot be read.'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingEvalCalls.delete(callId);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('The browser did not return a result in time.'));
      }, EVAL_TIMEOUT_MS);
      const onAbort = () => {
        pendingEvalCalls.delete(callId);
        clearTimeout(timer);
        reject(new Error('Aborted.'));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      pendingEvalCalls.set(callId, {
        resolve: (value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
        reject:  (e)     => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(e); },
      });
      sendToSession(sessionId, sseEvent('web-env-eval', { type: 'web-env-eval', callId, expression }));
    });
  }

  const webEnvTool = makeWebEnvTool(evalInBrowser);

  // The harness version stamped on every response as `x-matbot-version`, so a browser can notice it is
  // running against a server that has since been restarted on a different build and reload itself. The
  // single source is `about_matbot` — the same tool the UI already calls at bootstrap to fill
  // #matbot-version, which is what the client compares this header against; deriving it from this
  // package's own package.json instead would compare two unrelated version lines. Resolved once, in the
  // background (the tool registers after this server starts listening — see the boot grace note above),
  // and left undefined on failure: no header, so the client's check stays inert rather than false-firing.
  let harnessVersion: string | undefined;
  void (async () => {
    const tool = await resolveToolReady('about_matbot', watchAc.signal);
    if (!tool) return;
    const ac = new AbortController();
    try {
      for await (const ev of tool.executor.execute({}, makeToolCtx(ac))) {
        if (ev.type === 'result') {
          const v = (ev.value as { version?: unknown }).version;
          if (typeof v === 'string') harnessVersion = v;
          return;
        }
      }
    } catch { /* no version header; the client simply doesn't check */ }
  })();

  // Broadcast a session's busy/idle transition to the global status listeners (sidebar), deduped
  // against the last value. Authoritative busy comes from the runner (running || queued > 0).
  function updateBusy(sessionId: string): void {
    const busy = deps.run.status(sessionId).busy;
    if ((busyState.get(sessionId) ?? false) === busy) return;
    if (busy) busyState.set(sessionId, true); else busyState.delete(sessionId);
    broadcast(sseEvent('session-busy', { sessionId, busy }));
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    // Path only for routing; the query string (e.g. ?principal= on the SSE EventSource) is read off the
    // raw req.url by the principal resolvers, never by a route match.
    const rawUrl = req.url ?? '/';
    const url    = rawUrl.includes('?') ? rawUrl.slice(0, rawUrl.indexOf('?')) : rawUrl;

    // A dead socket — client gone, or the server torn down mid-stream while this plugin unloads —
    // makes a pending `res.write` (e.g. the SSE loop below) emit an async 'error' on a later tick.
    // That escapes the handler's try/catch and, with no listener, is an unhandled 'error' event that
    // exits the process. Writing to a dead socket is never fatal, so absorb it on both streams.
    req.on('error', () => {});
    res.on('error', () => {});

    // Set CORS headers on every response
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.setHeader(k, v);
    }
    // Every response carries the serving build, including the SSE streams and the static assets. Routes
    // that writeHead their own header object keep this one — writeHead merges over what setHeader set.
    if (harnessVersion !== undefined) res.setHeader('x-matbot-version', harnessVersion);

    if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

    try {
      // Establish the request's security principal at the entry, so every store/file/vault access
      // made while handling it (not just the submitted turn, which pump scopes separately) can read
      // it via currentPrincipal(). The resolver derives it from the request (default: one constant
      // placeholder); a plugin can register `services.WebPrincipalResolver` to read real identity off headers.
      const principal = await resolvePrincipal(req);
      await runAs(principal, () => handleRequest(req, res, method, url, principal));
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e) });
      else if (res.writable)  res.end();
    }
  });

  function makeToolCtx(ac: AbortController) {
    const now = new Date().toISOString();
    const stubSession: Session = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      status: 'active', messages: [],
      createdAt: now, updatedAt: now,
    };
    return {
      callId:     crypto.randomUUID(),
      session:    stubSession,
      signal:     ac.signal,
      vault:      deps.vault,
      loadPlugin:   deps.loadPlugin,
      unloadPlugin: deps.unloadPlugin,
      prompt:       nonInteractivePrompt,
      ...(deps.workdir    !== undefined ? { workdir:    deps.workdir    } : {}),
      ...(deps.files      !== undefined ? { files:      deps.files      } : {}),
      ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    };
  }

  // Resolve a tool by name against the *live registry* — never the ToolPresenter (which only culls what
  // the model is shown; HTTP references tools by name). If absent during the boot grace window, wait for
  // its `registered` event rather than 404 a tool that hasn't loaded yet. The subscription is taken
  // before re-checking so a registration landing in that gap can't be missed.
  async function resolveToolReady(name: string, signal: AbortSignal): Promise<Tool | null> {
    const reg = deps.tools;
    const immediate = reg?.resolve(name) ?? null;
    if (immediate || reg === undefined || Date.now() >= bootGraceUntil) return immediate;

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Give up at whichever comes first: the registry settling, or the hard ceiling. Re-armed rather than
    // polled — every wake-up either finds the registry quiet (and stops) or finds it moved on and waits
    // for the new deadline, so a boot that keeps registering keeps its grace.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armGiveUp = (): void => {
      const settleAt = Math.min(lastToolChangeAt + TOOL_REGISTRY_QUIET_MS, bootGraceUntil);
      const wait     = settleAt - Date.now();
      if (wait <= 0) { ac.abort(); return; }
      timer = setTimeout(armGiveUp, wait);
    };
    armGiveUp();
    const stream = deps.notifier.subscribe(ac.signal,
      n => n.kind === RegistryChangeKind && n.registry === 'tools' && n.operation === 'added' && n.name === name);
    const it = stream[Symbol.asyncIterator]();
    try {
      const first = it.next();                     // subscribes synchronously (before the first await)
      const raced = reg.resolve(name);             // catch a register() landing between the check above and subscribe
      if (raced) return raced;
      let r = await first;
      while (r.done !== true) {
        const t = reg.resolve(name);               // filtered to this tool's registration — just re-read it
        if (t) return t;
        r = await it.next();
      }
      return reg.resolve(name);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      await it.return?.();                          // end the watch subscription
    }
  }

  function static200(res: ServerResponse, contentType: string, path: string) {
    return async () => {
      try {
        // `no-cache` so the version-mismatch reload actually re-fetches the UI rather than replaying the
        // cached copy whose staleness triggered it.
        const body = await readFile(new URL(path, import.meta.url), "utf-8");
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      } catch (e: any) {
        json(res, e.code === 'ENOENT' ? 404 : 500, { error: String(e) });
      }
    };
  }
  async function handleRequest(
    req: IncomingMessage, res: ServerResponse, method: string, url: string, principal: Principal,
  ): Promise<void> {

    // --- Static UI ---
    const staticRoutes: Record<string, () => Promise<void>> = {
      '/': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/indx.html': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/app.js': static200(res, 'application/javascript; charset=utf-8', "../static/app.js"),
      '/http-transport.js': static200(res, 'application/javascript; charset=utf-8', "../static/http-transport.js"),
      '/favicon.ico': static200(res, 'image/svg+xml', "../static/favicon.svg"),
      // Hack - this exposes the web-bundle for testing purposes. In production, the web-bundle is served from the CDN.
      '/matbot.html': static200(res, 'text/html; charset=utf-8', "../../../../apps/web-bundle/dist/matbot.html"),
    };
    if (method === 'GET' && url in staticRoutes) {
      staticRoutes[url]?.();
      return;
    }

    // --- GET /health ---
    if (method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok' }); return;
    }

    // --- GET /events --- (one multiplexed SSE stream: session busy/idle plus every notification,
    // demuxed client-side by event name. One socket for the whole UI — see globalListeners.)
    if (method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('event stream open'));
      // Send current busy state so the client is up-to-date immediately. Reconcile against the
      // authoritative runner status first: a stale true (busyState that never got its idle
      // transition — e.g. a turn that ended with no events consumer attached) self-heals here,
      // broadcasting false to existing listeners instead of replaying a phantom busy.
      for (const sessionId of [...busyState.keys()]) {
        if (!deps.run.status(sessionId).busy) { updateBusy(sessionId); continue; }
        res.write(sseEvent('session-busy', { sessionId, busy: true }));
      }
      // Started on first connect, not at construction: a partitioning backend may register
      // WatchVisibility after frontend-web's setup, and the firehose must resolve it live.
      startFirehose();
      globalListeners.set(res, principal);
      const stopGlobalHeartbeat = heartbeat(res);
      req.on('close', () => { stopGlobalHeartbeat(); globalListeners.delete(res); });
      return; // keep connection open
    }

    // --- GET /sessions/:id --- (status only — busy is server-internal state, not session data)
    const sessionStatusMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && sessionStatusMatch) {
      json(res, 200, { busy: deps.run.status(sessionStatusMatch[1]!).busy }); return;
    }

    // --- POST /sessions ---
    if (method === 'POST' && url === '/sessions') {
      const session = createSession();
      await deps.store.set(session.id, session);
      json(res, 201, { id: session.id });
      return;
    }

    // --- POST /sessions/:id/submit ---
    const submitMatch = /^\/sessions\/([^/]+)\/submit$/.exec(url);
    if (method === 'POST' && submitMatch) {
      const sessionId = submitMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let body: SubmitBody;
      try { body = JSON.parse(raw) as SubmitBody; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const targetId  = body.sessionId ?? sessionId;
      const session   = await deps.store.get(targetId);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }

      const traceId = body.traceId ?? crypto.randomUUID();

      // Normalise content into MessageContent[]. The runner appends + persists the user message
      // when this submission's turn actually starts (persist-at-turn-start) — never here — so a
      // mid-turn submit queues behind the running turn instead of clobbering session state.
      const contentArr = typeof body.content === 'string'
        ? [{ type: 'text' as const, text: body.content }]
        : [body.content];

      // Fire-and-forget: we enqueue and return immediately. The turn's output — and this prompt —
      // reach the client over its persistent GET /events/sessions/:id stream, not this request.
      // Answered via POST /sessions/:id/prompt. (Only one prompt is outstanding per session, since
      // turns are serialised.)
      const promptFn = ((p: string | FormField, defaultValue?: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const def = typeof p === 'string' ? defaultValue : p.default;
          // Every settle path funnels through these two, so announcing here covers all of them: an answer
          // from any viewer, an abort, and the no-viewers-left release. The dialog is drawn in EVERY
          // browser attached to the session but can only be answered once — without this the other
          // browsers would sit on a dead prompt forever.
          const settled = (): void => {
            pendingPrompts.delete(targetId);
            sendToSession(targetId, sseEvent('prompt-resolved', { type: 'prompt-resolved', traceId }));
          };
          // Built once and kept, so a stream that connects later is told about it (see pendingPrompts).
          const event = sseEvent('prompt', {
            type: 'prompt',
            traceId,
            question: typeof p === 'string' ? p : p.label,
            ...(def !== undefined ? { defaultValue: def } : {}),
            ...(typeof p === 'string' ? {} : { field: p }),
          });
          pendingPrompts.set(targetId, {
            event,
            resolve: answer => { settled(); resolve(answer || def || ''); },
            cancel:  ()     => { settled(); reject(promptCancelledError()); },
          });
          sendToSession(targetId, event);
        })) as PromptFn;

      // The first submit of a busy period anchors the server-owned busy tracker on its OWN view
      // (claimed synchronously here, before any await, so two near-simultaneous submits can't both
      // become trackers). Concat/queued submits arriving mid-turn reuse it and don't tap their events.
      const isTracker = !busyTrackers.has(targetId);
      if (isTracker) busyTrackers.add(targetId);
      const trackAc = new AbortController();
      try {
        const view = await deps.run.open({
          sessionId:   targetId,
          signal:      isTracker ? trackAc.signal : new AbortController().signal,
          content:     contentArr,
          provider:    body.provider,
          principal,
          prompt:      promptFn,
          traceId,
          concatQueue: body.concatQueue ?? false, // per-submission; conservative default (own turn) when unspecified
          mode:        body.mode ?? 'auto',        // the web frontend opts into steering; 'auto' defers to the SteeringPolicy (else host default)
        });
        updateBusy(targetId);
        json(res, 200, { queued: view.queued, traceId: view.traceId });

        // Server-owned busy tracker. The busy:false broadcast requires *someone* draining this
        // session's stream when the turn ends — but a client's GET /events/sessions/:id consumer may
        // not be attached (user switched away). So whoever turns busy ON owns turning it OFF: drain
        // this submission's own view until the runner's deterministic `idle` event, driving updateBusy.
        // The view was subscribed (the `events` getter) before pump can run, so it can't miss even a
        // fast/erroring turn; one tracker per busy period, so cost is bounded by concurrent running
        // turns, nothing on idle sessions.
        if (isTracker) {
          void (async () => {
            try {
              for await (const ev of view.events) {
                updateBusy(targetId);
                // Tear down only on a *genuine* idle. `idle` fires after `running` flips false, so
                // status() is authoritative here: if a back-to-back submit has already re-armed the
                // session (running again, or freshly queued), keep tracking — this same view stays
                // subscribed across pump restarts and will see the next idle.
                if (ev.type === 'idle' && !deps.run.status(targetId).busy) break;
              }
            } catch { /* stream torn down */ }
            finally { busyTrackers.delete(targetId); trackAc.abort(); }
          })();
        }
      } catch (e) {
        if (isTracker) busyTrackers.delete(targetId);
        json(res, 500, { error: String(e) });
      }
      return;
    }

    // --- GET /events/sessions/:id --- (persistent per-session SSE: ALL turn output for the session)
    const eventsMatch = /^\/events\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && eventsMatch) {
      const sId = eventsMatch[1]!;
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('events stream open'));
      const stopHeartbeat = heartbeat(res);

      let conns = sessionConns.get(sId);
      if (conns === undefined) { conns = new Set(); sessionConns.set(sId, conns); }
      conns.add(res);

      // A prompt outstanding on this session, to a viewer that was not here when it was raised (or was
      // a socket nobody had reaped yet). Sent before this turn's replay, and that placement is sound
      // rather than lucky: `renderTurn` creates its assistant wrap lazily on first activity, and the
      // running turn's user message is already in the committed history the client renders before
      // connecting — so the wrap lands after that bubble whichever event arrives first. Order *within*
      // the wrap is cosmetic and only differs on a resumed stream.
      const parked = pendingPrompts.get(sId);
      if (parked !== undefined) {
        // Logged because this is the recovery nobody can see from the outside: the client cannot tell a
        // re-sent prompt from a first one, which is the point, so the server is the only place the fact
        // that a question was rescued is observable at all.
        console.log(`[frontend-web] re-sent the outstanding prompt for session ${sId} to a new stream`);
        res.write(parked.event);
      }

      const ac = new AbortController();
      req.on('close', () => {
        stopHeartbeat();
        ac.abort();
        const set = sessionConns.get(sId);
        if (set) {
          set.delete(res);
          if (set.size === 0) sessionConns.delete(sId);
        }
        // A pending prompt is deliberately LEFT pending. This used to resolve it with '', which the
        // promptFn turns into the field's default — an answer nobody gave, for a question nobody saw.
        // Harmless-looking on a confirm (it declines) and destructive on `plugin store-key`, whose
        // default is '' and where blank REMOVES the key. Nothing about a viewer going away is a
        // decision, and the prompt now survives to be re-sent to the next one; a user who really is
        // finished with it has POST /abort, which cancels rather than invents.
      });

      const view = await deps.run.open({ sessionId: sId, signal: ac.signal });
      void (async () => {
        try {
          for await (const ev of view.events) {
            if (!res.writable) break;
            // `idle` is the runner's busy→idle lifecycle signal (session-runner pump): it arrives
            // *after* `running` flips false, so updateBusy reads an authoritative idle with no
            // microtask race. It's status bookkeeping, not turn content — don't forward it to the
            // client (app.js has no case for it).
            if (ev.type === 'idle') { updateBusy(sId); continue; }
            res.write(sseEvent(ev.type, ev));
            updateBusy(sId);
          }
        } catch { /* stream torn down */ }
      })();
      return;
    }

    // --- POST /sessions/:id/abort ---
    const abortMatch = /^\/sessions\/([^/]+)\/abort$/.exec(url);
    if (method === 'POST' && abortMatch) {
      const sId    = abortMatch[1]!;
      // Release any pending prompt first so a turn parked on ctx.prompt() can observe the abort
      // rather than hang, then drop the queue + abort the running turn. Cancel, not resolve('') —
      // giving up is the one thing the user unambiguously did, and PromptCancelledError is how a tool
      // is told so; resolving would hand it the field's default as though it had been chosen.
      pendingPrompts.get(sId)?.cancel();
      deps.run.abort(sId);
      updateBusy(sId);
      json(res, 200, { ok: true });
      return;
    }

    // --- POST /tools/:name (buffered JSON response) ---
    const toolCallMatch = /^\/tools\/([^/]+)$/.exec(url);
    if (method === 'POST' && toolCallMatch) {
      const toolName = toolCallMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let input: unknown;
      try { input = raw ? JSON.parse(raw) : null; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const tool = await resolveToolReady(toolName, ac.signal);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      const toolCtx = makeToolCtx(ac);
      let stdout = '';
      let stderr = '';
      try {
        for await (const ev of tool.executor.execute(input, toolCtx)) {
          if (ev.type === 'result') { json(res, 200, ev.value); return; }
          if (ev.type === 'stdout') { stdout += ev.chunk; }
          if (ev.type === 'stderr') { stderr += ev.chunk; }
          if (ev.type === 'error')  {
            json(res, 500, {
              error: ev.message,
              ...(ev.code !== undefined ? { code: ev.code } : {}),
              ...(stdout               ? { stdout }         : {}),
              ...(stderr               ? { stderr }         : {}),
            });
            return;
          }
        }
        json(res, 500, { error: 'Tool returned no result' });
      } catch (e) {
        json(res, 500, { error: String(e), ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      }
      return;
    }

    // --- POST /stream/tools/:name (SSE streaming) ---
    const streamToolMatch = /^\/stream\/tools\/([^/]+)$/.exec(url);
    if (method === 'POST' && streamToolMatch) {
      const toolName = streamToolMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let input: unknown;
      try { input = raw ? JSON.parse(raw) : null; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const tool = await resolveToolReady(toolName, ac.signal);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('tool stream open'));

      try {
        for await (const ev of tool.executor.execute(input, makeToolCtx(ac))) {
          if (!res.writable) break;
          res.write(sseEvent(ev.type, ev));
        }
      } catch (e) {
        if (res.writable) res.write(sseEvent('error', { type: 'error', message: String(e) }));
      } finally {
        res.end();
      }
      return;
    }

    // --- POST /sessions/:id/prompt ---
    const promptMatch = /^\/sessions\/([^/]+)\/prompt$/.exec(url);
    if (method === 'POST' && promptMatch) {
      const sId = promptMatch[1]!;
      let body: { answer?: string; cancel?: boolean };
      try { body = JSON.parse(await readBody(req)) as { answer?: string; cancel?: boolean }; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const entry = pendingPrompts.get(sId);
      if (!entry) { json(res, 409, { error: 'No pending prompt for this session' }); return; }
      if (body.cancel) {
        // Give up: reject the prompt (the tool closes its call with an error result) and abandon the
        // turn without disturbing the queue — pump advances to the next submission or idles.
        entry.cancel();
        deps.run.cancelTurn(sId);
      } else {
        entry.resolve(body.answer ?? '');
      }
      json(res, 200, { ok: true });
      return;
    }

    // --- POST /sessions/:id/env-result --- (answer for a parked web_user_environment round-trip)
    const envResultMatch = /^\/sessions\/([^/]+)\/env-result$/.exec(url);
    if (method === 'POST' && envResultMatch) {
      let body: { callId?: string; ok?: boolean; value?: unknown; error?: string };
      try { body = JSON.parse(await readBody(req)) as typeof body; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const entry = body.callId ? pendingEvalCalls.get(body.callId) : undefined;
      if (!entry) { json(res, 409, { error: 'No pending web_user_environment call' }); return; }
      pendingEvalCalls.delete(body.callId!);
      if (body.ok) entry.resolve(body.value);
      else entry.reject(new Error(typeof body.error === 'string' && body.error ? body.error : 'Browser evaluation failed.'));
      json(res, 200, { ok: true });
      return;
    }

    // --- GET /files/[~<partition>/]<namespace>/<name> --- (read-only static access; only files marked `allowed`)
    // A browser GET (img/anchor/download) can't send the x-matbot-principal header, so a partitioned file's
    // owning file area rides in the path as an optional leading `~<partition>` segment (minted by
    // url_for_resource). `~` is excluded from partition ids and namespaces, so the segment is unambiguous.
    // The token is opaque here and resolved by the backend that minted it (`FilePartition.enter`) — this
    // route used to re-enter it as a principal, which is a guess at the routing the backend owns.
    // Bare paths are served from the request principal (base in a default deployment) — unchanged.
    const fileMatch = /^\/files\/(?:~([^/]+)\/)?([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileMatch && deps.files) {
      let partition: string | undefined, namespace: string, name: string;
      try {
        partition = fileMatch[1] !== undefined ? decodeURIComponent(fileMatch[1]) : undefined;
        namespace = decodeURIComponent(fileMatch[2]!); name = decodeURIComponent(fileMatch[3]!);
      }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      // One read serves and gates: the handle we need to stream also carries `allowed`. A file that
      // isn't servable is reported as missing, not forbidden — don't reveal that the path exists.
      const read = () => deps.files!.getByName(name, namespace);
      // No service ⇒ nothing partitions the file area, so there is only one area a token could name.
      const filePartition = deps.filePartition?.();
      const handle = partition !== undefined && filePartition
        ? await filePartition.enter(partition, read)
        : await read();
      if (!handle) { json(res, 404, { error: 'Not found' }); return; }
      if (!handle.allowed) { json(res, 403, { error: 'Not allowed' }); return; }

      res.writeHead(200, {
        'content-type':  handle.mimeType,
        'cache-control': 'no-cache',
        ...corsHeaders(origin),
      });
      for await (const chunk of handle.stream()) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    json(res, 404, { error: 'Not found' });
  }

  async function close(): Promise<void> {
    // Close all persistent per-session event streams.
    for (const conns of sessionConns.values()) for (const res of conns) res.end();
    sessionConns.clear();
    busyState.clear();

    // Close the multiplexed global event stream(s).
    for (const res of globalListeners.keys()) res.end();
    globalListeners.clear();

    watchAc.abort();                              // ends the firehose subscription

    // Settle all pending prompts so callers don't hang. Cancelled, not defaulted: the server going
    // away is not an answer, and a tool reports a cancel as an error rather than acting on it.
    for (const entry of pendingPrompts.values()) entry.cancel();
    pendingPrompts.clear();

    // Reject any in-flight environment round-trips so their tool calls close with an error.
    for (const entry of pendingEvalCalls.values()) entry.reject(new Error('Server shutting down.'));
    pendingEvalCalls.clear();

    await new Promise<void>((resolve) =>
      server.close(err => {
        if (err) {
          console.warn('[frontend-web] Error closing server:', String(err));
        }
        resolve();
      }),
    );
  }

  return { server, close, webEnvTool };
}

