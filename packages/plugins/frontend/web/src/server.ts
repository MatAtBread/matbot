import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MatbotPlugin, Principal, Session, Store, ToolRegistry, FileStore, Vault,
  FormField, PromptFn, SessionRunner,
} from '@matatbread/matbot-core';
import { createSession, PromptCancelledError, runAs, tryCurrentPrincipal } from '@matatbread/matbot-core';
import { sseComment, sseEvent } from './sse-writer.js';
import { favicon, html, httpTransport, js  } from './ui.js';

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
  configPath?:    string;
  /** Derives the security principal for each request. Defaults to {@link defaultWebPrincipal}. */
  resolvePrincipal?: WebPrincipalResolver;
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
}

// Last-resort anonymous identity, used only when no boot principal is established and no resolver
// override is registered (e.g. tests, or a realm with no carrier).
const ANONYMOUS_WEB_USER: Principal = {
  id:   'web-user',
  type: 'user',
};

// All matbot frontends are single-principal today, so the default request identity is the process
// boot principal (the pod/sandbox/system identity established at the entry) — keeping web sessions
// attributed to the same identity as the rest of the app. A multi-user deployment registers a
// `WebPrincipalResolver` (e.g. deriving identity from headers) which overrides this entirely; that
// override is deliberately NOT chained to the boot principal, so it never leaks the operator
// identity to anonymous visitors.
export const defaultWebPrincipal: WebPrincipalResolver = () => tryCurrentPrincipal() ?? ANONYMOUS_WEB_USER;

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
  };
}

function static200(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
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

  // Persistent per-session event subscribers (the GET /sessions/:id/events SSE streams). Submits are
  // fire-and-forget — all turn output, and interactive prompts, reach clients over these. Holding one
  // connection per session (not per submission) is what keeps queued submits off the browser's
  // ~6-socket-per-host limit, which otherwise starved both the `queued` signal and POST /prompt.
  const sessionConns = new Map<string, Set<ServerResponse>>();
  const busyState    = new Map<string, boolean>();                     // last-broadcast busy per session
  // Sessions with a live server-owned busy tracker (see the submit handler). One transient tracker
  // per busy period drives the idle broadcast independently of any client events stream.
  const busyTrackers = new Set<string>();
  // session ID → the parked prompt's settlers. `resolve` delivers an answer (applying the default
  // fallback); `cancel` rejects it with PromptCancelledError — the "give up" path.
  const pendingPrompts = new Map<string, { resolve: (answer: string) => void; cancel: () => void }>();

  // Clients subscribed to server-sent session status events (busy/idle).
  const statusListeners = new Set<ServerResponse>();

  // Clients subscribed to file-change events. The global set gets every namespace's events (each
  // carries its `namespace`, so the client routes each to the right panel); the per-file map is
  // keyed by `<namespace>/<name>` so single-file watchers don't collide across namespaces.
  const allFileListeners   = new Set<ServerResponse>();
  const fileEventListeners = new Map<string, Set<ServerResponse>>();
  const watchAc            = new AbortController();

  if (deps.files?.watch) {
    void (async () => {
      for await (const event of deps.files!.watch!(watchAc.signal)) {
        const msg = sseEvent('file-changed', event);
        for (const res of allFileListeners) {
          if (res.writable) res.write(msg); else allFileListeners.delete(res);
        }
        const subs = fileEventListeners.get(`${event.namespace ?? ''}/${event.name}`);
        if (subs) {
          for (const res of subs) {
            if (res.writable) res.write(msg); else subs.delete(res);
          }
        }
      }
    })();
  }

  function sendToSession(sessionId: string, msg: string): void {
    const conns = sessionConns.get(sessionId);
    if (conns === undefined) return;
    for (const res of conns) { if (res.writable) res.write(msg); else conns.delete(res); }
  }

  // Broadcast a session's busy/idle transition to the global status listeners (sidebar), deduped
  // against the last value. Authoritative busy comes from the runner (running || queued > 0).
  function updateBusy(sessionId: string): void {
    const busy = deps.run.status(sessionId).busy;
    if ((busyState.get(sessionId) ?? false) === busy) return;
    if (busy) busyState.set(sessionId, true); else busyState.delete(sessionId);
    const msg = sseEvent('session-busy', { sessionId, busy });
    for (const res of statusListeners) { if (res.writable) res.write(msg); else statusListeners.delete(res); }
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url    = req.url ?? '/';

    // Set CORS headers on every response
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.setHeader(k, v);
    }

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

  function makeToolCtx(ac: AbortController, principal: Principal) {
    const now = new Date().toISOString();
    const stubSession: Session = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      ownerPrincipalId: principal.id,
      status: 'active', contexts: [], messages: [],
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

  async function handleRequest(
    req: IncomingMessage, res: ServerResponse, method: string, url: string, principal: Principal,
  ): Promise<void> {

    // --- Static UI ---
    if (method === 'GET' && url === '/')       { static200(res, 'text/html; charset=utf-8',              await html()); return; }
    if (method === 'GET' && url === '/app.js') { static200(res, 'application/javascript; charset=utf-8', await js());   return; }
    if (method === 'GET' && url === '/http-transport.js') { static200(res, 'application/javascript; charset=utf-8', await httpTransport()); return; }
    if (method === 'GET' && url === '/favicon.ico') { static200(res, 'image/svg+xml', await favicon()); return; }

    // --- GET /health ---
    if (method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok' }); return;
    }

    // --- GET /sessions/events --- (SSE stream for session busy/idle status changes)
    if (method === 'GET' && url === '/sessions/events') {
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('status stream open'));
      // Send current busy state so the client is up-to-date immediately. Reconcile against the
      // authoritative runner status first: a stale true (busyState that never got its idle
      // transition — e.g. a turn that ended with no events consumer attached) self-heals here,
      // broadcasting false to existing listeners instead of replaying a phantom busy.
      for (const sessionId of [...busyState.keys()]) {
        if (!deps.run.status(sessionId).busy) { updateBusy(sessionId); continue; }
        res.write(sseEvent('session-busy', { sessionId, busy: true }));
      }
      statusListeners.add(res);
      req.on('close', () => { statusListeners.delete(res); });
      return; // keep connection open
    }

    // --- GET /sessions/:id --- (status only — busy is server-internal state, not session data)
    const sessionStatusMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && sessionStatusMatch) {
      json(res, 200, { busy: deps.run.status(sessionStatusMatch[1]!).busy }); return;
    }

    // --- POST /sessions ---
    if (method === 'POST' && url === '/sessions') {
      const session = createSession({ ownerPrincipal: principal });
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
      // reach the client over its persistent GET /sessions/:id/events stream, not this request.
      // Answered via POST /sessions/:id/prompt. (Only one prompt is outstanding per session, since
      // turns are serialised.)
      const promptFn = ((p: string | FormField, defaultValue?: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const def = typeof p === 'string' ? defaultValue : p.default;
          pendingPrompts.set(targetId, {
            resolve: answer => { pendingPrompts.delete(targetId); resolve(answer || def || ''); },
            cancel:  ()     => { pendingPrompts.delete(targetId); reject(new PromptCancelledError()); },
          });
          sendToSession(targetId, sseEvent('prompt', {
            type: 'prompt',
            traceId,
            question: typeof p === 'string' ? p : p.label,
            ...(def !== undefined ? { defaultValue: def } : {}),
            ...(typeof p === 'string' ? {} : { field: p }),
          }));
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
        });
        updateBusy(targetId);
        json(res, 200, { queued: view.queued, traceId: view.traceId });

        // Server-owned busy tracker. The busy:false broadcast requires *someone* draining this
        // session's stream when the turn ends — but a client's GET /sessions/:id/events consumer may
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

    // --- GET /sessions/:id/events --- (persistent per-session SSE: ALL turn output for the session)
    const eventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(url);
    if (method === 'GET' && eventsMatch) {
      const sId = eventsMatch[1]!;
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('events stream open'));

      let conns = sessionConns.get(sId);
      if (conns === undefined) { conns = new Set(); sessionConns.set(sId, conns); }
      conns.add(res);

      const ac = new AbortController();
      req.on('close', () => {
        ac.abort();
        const set = sessionConns.get(sId);
        if (set) {
          set.delete(res);
          if (set.size === 0) {
            sessionConns.delete(sId);
            // No viewers left: release any pending prompt so a turn parked on ctx.prompt() doesn't
            // hang awaiting an answer that can never arrive.
            const r = pendingPrompts.get(sId);
            if (r) { pendingPrompts.delete(sId); r.resolve(''); }
          }
        }
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
      // rather than hang, then drop the queue + abort the running turn.
      const r = pendingPrompts.get(sId);
      if (r) { pendingPrompts.delete(sId); r.resolve(''); }
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

      const tool = deps.tools?.resolve(toolName);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const toolCtx = makeToolCtx(ac, principal);
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

      const tool = deps.tools?.resolve(toolName);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('tool stream open'));

      try {
        for await (const ev of tool.executor.execute(input, makeToolCtx(ac, principal))) {
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

    // --- GET /files/events --- (SSE: file-change events across all namespaces; client filters by namespace)
    if (method === 'GET' && url === '/files/events') {
      if (!deps.files?.watch) { json(res, 404, { error: 'File watch not available' }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write(sseComment('file watch stream open'));
      allFileListeners.add(res);
      req.on('close', () => allFileListeners.delete(res));
      return;
    }

    // --- GET /files/events/<namespace>/<name> --- (SSE: single-file watch)
    const fileEventMatch = /^\/files\/events\/([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileEventMatch) {
      if (!deps.files?.watch) { json(res, 404, { error: 'File watch not available' }); return; }
      let key: string;
      try { key = `${decodeURIComponent(fileEventMatch[1]!)}/${decodeURIComponent(fileEventMatch[2]!)}`; }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write(sseComment(`watching ${key}`));

      let subs = fileEventListeners.get(key);
      if (subs === undefined) { subs = new Set(); fileEventListeners.set(key, subs); }
      subs.add(res);
      req.on('close', () => {
        const s = fileEventListeners.get(key);
        if (s) { s.delete(res); if (s.size === 0) fileEventListeners.delete(key); }
      });
      return;
    }

    // --- GET /files/<namespace>/<name> --- (read-only static access; only files marked `allowed`)
    const fileMatch = /^\/files\/([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileMatch && deps.files) {
      let namespace: string, name: string;
      try { namespace = decodeURIComponent(fileMatch[1]!); name = decodeURIComponent(fileMatch[2]!); }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      // One read serves and gates: the handle we need to stream also carries `allowed`. A file that
      // isn't servable is reported as missing, not forbidden — don't reveal that the path exists.
      const handle = await deps.files.getByName(name, namespace);
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

    // Close all status stream connections.
    for (const res of statusListeners) res.end();
    statusListeners.clear();

    // Stop file watcher and close all watch SSE connections.
    watchAc.abort();
    for (const res of allFileListeners) res.end();
    allFileListeners.clear();
    for (const subs of fileEventListeners.values()) for (const res of subs) res.end();
    fileEventListeners.clear();

    // Resolve all pending prompts so callers don't hang.
    for (const entry of pendingPrompts.values()) entry.resolve('');
    pendingPrompts.clear();

    await new Promise<void>((resolve) =>
      server.close(err => {
        if (err) {
          console.warn('[frontend-web] Error closing server:', String(err));
        }
        resolve();
      }),
    );
  }

  return { server, close };
}
