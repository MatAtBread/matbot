import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MatbotPlugin, Principal, Session, Store, Tool, ToolRegistry, FileStore, Vault,
  FormField, PromptFn, SessionRunner, PluginRegistryEvent,
} from '@matatbread/matbot-core';
import { createSession, promptCancelledError, runAs, tryCurrentPrincipal } from '@matatbread/matbot-core';
import type { SkillManager } from '@matatbread/matbot-skills';
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
  watchPlugins?:  (signal?: AbortSignal) => AsyncIterable<PluginRegistryEvent>;
  tools?:         ToolRegistry;
  // Resolved lazily (a thunk, not a captured value) because the skills plugin may register its
  // SkillManager *after* frontend-web sets up — load order isn't guaranteed. Returns undefined until
  // then; the watch loop is started on first /events connect, by which point boot is complete.
  skills?:        () => SkillManager | undefined;
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

// The default request identity when no header and no override resolver apply: the process boot principal
// (the pod/sandbox/system identity established at the entry), keeping web sessions attributed to the same
// identity as the rest of the app. The header still wins here too, for when this default is used directly.
export const defaultWebPrincipal: WebPrincipalResolver = (req) =>
  headerPrincipal(req) ?? tryCurrentPrincipal() ?? ANONYMOUS_WEB_USER;

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

  // Persistent per-session event subscribers (the GET /events/sessions/:id SSE streams). Submits are
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
  // call ID → settlers for an in-flight web_user_environment round-trip. Keyed by the tool call's
  // `callId` (not session id) because a turn can issue parallel tool calls; the answer arrives via
  // POST /sessions/:id/env-result carrying that callId. See evalInBrowser below.
  const pendingEvalCalls = new Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>();

  // One multiplexed event stream (GET /events) carries every global, non-session event — session
  // busy/idle, file changes, and tool/skill/plugin CRUD — each tagged by name and demuxed client-side.
  // Browsers cap HTTP/1.1 at ~6 sockets per host; a separate SSE connection per panel would exhaust
  // that and starve ordinary fetches (the sidebar load, tool calls), so the whole UI shares one socket.
  const globalListeners = new Set<ServerResponse>();

  const broadcast = (msg: string): void => {
    for (const res of globalListeners) { if (res.writable) res.write(msg); else globalListeners.delete(res); }
  };

  // Per-file watchers (GET /events/files/:ns/:name), keyed `<namespace>/<name>` so single-file streams
  // don't collide across namespaces. Separate from the global stream: a targeted watch, not the firehose.
  const fileEventListeners = new Map<string, Set<ServerResponse>>();
  const watchAc            = new AbortController();

  if (deps.files?.watch) {
    void (async () => {
      for await (const event of deps.files!.watch!(watchAc.signal)) {
        const msg = sseEvent('file-changed', event);
        broadcast(msg);
        const subs = fileEventListeners.get(`${event.namespace ?? ''}/${event.name}`);
        if (subs) for (const res of subs) { if (res.writable) res.write(msg); else subs.delete(res); }
      }
    })();
  }

  if (deps.tools) {
    void (async () => {
      for await (const event of deps.tools!.watch(watchAc.signal)) broadcast(sseEvent('tool-changed', event));
    })();
  }

  // Skill content CRUD (save/delete), including saves the LLM makes mid-turn via skill_action. The
  // SkillManager is resolved lazily on first /events connect (see deps.skills) because the skills plugin
  // may load after frontend-web; the watch loop starts at most once, the first time a client subscribes.
  let skillWatchStarted = false;

  function startSkillWatch(skills: SkillManager): void {
    if (skillWatchStarted) return;
    skillWatchStarted = true;
    void (async () => {
      for await (const event of skills.watch(watchAc.signal)) broadcast(sseEvent('skill-changed', event));
    })();
  }

  // Plugin load/unload. Covers tool-less plugins (pure provider/hook/storage — e.g. the storage backend
  // itself) that the tool-changed stream can't see.
  if (deps.watchPlugins) {
    void (async () => {
      for await (const event of deps.watchPlugins!(watchAc.signal)) broadcast(sseEvent('plugin-changed', event));
    })();
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
    const url    = req.url ?? '/';

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
    const timer = setTimeout(() => ac.abort(), Math.max(0, bootGraceUntil - Date.now()));
    const it = reg.watch(ac.signal)[Symbol.asyncIterator]();
    try {
      const first = it.next();                     // subscribes synchronously (before the first await)
      const raced = reg.resolve(name);             // catch a register() landing between the check above and subscribe
      if (raced) return raced;
      let r = await first;
      while (r.done !== true) {
        if (r.value.type === 'registered' && r.value.name === name) {
          const t = reg.resolve(name);
          if (t) return t;
        }
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
        const body = await readFile(new URL(path, import.meta.url), "utf-8");
        res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
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

    // --- GET /events --- (one multiplexed SSE stream: session busy/idle, file changes, and tool/skill/
    // plugin CRUD, demuxed client-side by event name. One socket for the whole UI — see globalListeners.)
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
      // Wire skill CRUD lazily: by first connect the skills plugin has finished setup (load order may
      // place it after frontend-web), so deps.skills() now resolves.
      const skills = deps.skills?.();
      if (skills) startSkillWatch(skills);
      globalListeners.add(res);
      req.on('close', () => { globalListeners.delete(res); });
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
          pendingPrompts.set(targetId, {
            resolve: answer => { pendingPrompts.delete(targetId); resolve(answer || def || ''); },
            cancel:  ()     => { pendingPrompts.delete(targetId); reject(promptCancelledError()); },
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

    // --- GET /events/files/<namespace>/<name> --- (SSE: single-file watch)
    const fileEventMatch = /^\/events\/files\/([^/]+)\/(.+)$/.exec(url);
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

    // --- GET /files/[~<principal>/]<namespace>/<name> --- (read-only static access; only files marked `allowed`)
    // A browser GET (img/anchor/download) can't send the x-matbot-principal header, so a profiled file's
    // owning partition rides in the path as an optional leading `~<principal>` segment (minted by
    // url_for_resource). `~` is excluded from principal ids and namespaces, so the segment is unambiguous.
    // Bare paths are served from the request principal (base in a default deployment) — unchanged.
    const fileMatch = /^\/files\/(?:~([^/]+)\/)?([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileMatch && deps.files) {
      let filePrincipal: string | undefined, namespace: string, name: string;
      try {
        filePrincipal = fileMatch[1] !== undefined ? decodeURIComponent(fileMatch[1]) : undefined;
        namespace = decodeURIComponent(fileMatch[2]!); name = decodeURIComponent(fileMatch[3]!);
      }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      // One read serves and gates: the handle we need to stream also carries `allowed`. A file that
      // isn't servable is reported as missing, not forbidden — don't reveal that the path exists.
      const read = () => deps.files!.getByName(name, namespace);
      const handle = filePrincipal !== undefined
        ? await runAs({ id: filePrincipal, type: 'user' }, read)
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
    for (const res of globalListeners) res.end();
    globalListeners.clear();

    // Stop the watch loops and close the per-file watch SSE connections.
    watchAc.abort();
    for (const subs of fileEventListeners.values()) for (const res of subs) res.end();
    fileEventListeners.clear();

    // Resolve all pending prompts so callers don't hang.
    for (const entry of pendingPrompts.values()) entry.resolve('');
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

