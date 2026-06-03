import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import type {
  HookRegistry, MatbotPlugin, Principal, ProviderAdapter, ProviderConfig,
  Session, Store, ToolRegistry, FileStore, SystemContextRegistry,
} from '@matatbread/matbot-core';
import { appendMessage, createMessage, createSession, runSession } from '@matatbread/matbot-core';
import { sseComment, sseEvent } from './sse-writer.js';
import { html, js, favicon } from './ui.js';

export interface WebServerDeps {
  store:          Store<Session>;
  /** Resolve a provider name to its adapter and fully-resolved config. Returns null if unknown. */
  resolveProvider: (name: string) => Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null>;
  loadPlugin:     (specifier: string) => Promise<MatbotPlugin>;
  unloadPlugin:   (specifier: string) => Promise<void>;
  tools?:         ToolRegistry;
  hooks?:         HookRegistry;
  systemContext?: SystemContextRegistry;
  cors?:          string;  // Access-Control-Allow-Origin value, default '*'
  workdir?:       string;
  files?:         FileStore;
  configPath?:    string;
}

interface SubmitBody {
  content:    string | { type: 'form-response'; values: Record<string, string> };
  provider:   string;       // opaque name passed to deps.resolveProvider
  sessionId?: string;
  traceId?:   string;
}

// Single server-side principal used for all requests until real auth is added.
const DEFAULT_PRINCIPAL: Principal = {
  id:       'web-user',
  type:     'user',
  grants:   [
    { capability: 'network' },
    { capability: 'filesystem' },
    { capability: 'spawn' },
    { capability: 'container' },
    { capability: 'audit:read' },
  ],
  contexts: [],
};

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

const WORKSPACE_MIME: Record<string, string> = {
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
};

function static200(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createWebServer(deps: WebServerDeps) {
  const origin = deps.cors ?? '*';

  // Fan-out: each active submit gets a subscriber set, replay buffer, and its AbortController.
  const activeSessions = new Map<string, { subs: Set<ServerResponse>; buffer: string[]; ac: AbortController }>();
  const pendingPrompts  = new Map<string, (answer: string) => void>(); // session ID → resolver

  // Clients subscribed to server-sent session status events (busy/idle).
  const statusListeners = new Set<ServerResponse>();

  // Clients subscribed to workspace file-change events.
  const workspaceEventListeners = new Set<ServerResponse>();
  const fileEventListeners      = new Map<string, Set<ServerResponse>>();
  const watchAc                 = new AbortController();

  if (deps.files?.watch) {
    void (async () => {
      for await (const event of deps.files!.watch!(watchAc.signal)) {
        if (event.namespace !== 'workspace') continue;
        const msg = sseEvent('file-changed', event);
        for (const res of workspaceEventListeners) {
          if (res.writable) res.write(msg); else workspaceEventListeners.delete(res);
        }
        const subs = fileEventListeners.get(event.name);
        if (subs) {
          for (const res of subs) {
            if (res.writable) res.write(msg); else subs.delete(res);
          }
        }
      }
    })();
  }

  function broadcastStatus(sessionId: string, busy: boolean): void {
    const msg = sseEvent('session-busy', { sessionId, busy });
    for (const res of statusListeners) {
      if (res.writable) res.write(msg);
      else statusListeners.delete(res);
    }
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
      await handleRequest(req, res, method, url);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e) });
      else if (res.writable)  res.end();
    }
  });

  function makeToolCtx(ac: AbortController) {
    const now = new Date().toISOString();
    const stubSession: Session = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      ownerPrincipalId: DEFAULT_PRINCIPAL.id,
      status: 'active', contexts: [], messages: [],
      createdAt: now, updatedAt: now,
    };
    return {
      callId:     crypto.randomUUID(),
      session:    stubSession,
      principal:  DEFAULT_PRINCIPAL,
      signal:     ac.signal,
      loadPlugin:   deps.loadPlugin,
      unloadPlugin: deps.unloadPlugin,
      prompt:     (q: string, def?: string) => def !== undefined
        ? Promise.resolve(def)
        : Promise.reject(new Error(`Non-interactive context: "${q}"`)),
      ...(deps.workdir    !== undefined ? { workdir:    deps.workdir    } : {}),
      ...(deps.files      !== undefined ? { files:      deps.files      } : {}),
      ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    };
  }

  async function handleRequest(
    req: IncomingMessage, res: ServerResponse, method: string, url: string,
  ): Promise<void> {

    // --- Static UI ---
    if (method === 'GET' && url === '/')       { static200(res, 'text/html; charset=utf-8',              await html()); return; }
    if (method === 'GET' && url === '/app.js') { static200(res, 'application/javascript; charset=utf-8', await js());   return; }
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
      // Send current busy state so the client is up-to-date immediately.
      for (const sessionId of activeSessions.keys()) {
        res.write(sseEvent('session-busy', { sessionId, busy: true }));
      }
      statusListeners.add(res);
      req.on('close', () => { statusListeners.delete(res); });
      return; // keep connection open
    }

    // --- GET /sessions/:id --- (status only — busy is server-internal state, not session data)
    const sessionStatusMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && sessionStatusMatch) {
      json(res, 200, { busy: activeSessions.has(sessionStatusMatch[1]!) }); return;
    }

    // --- POST /sessions ---
    if (method === 'POST' && url === '/sessions') {
      const session = createSession({ ownerPrincipal: DEFAULT_PRINCIPAL });
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
      let   session   = await deps.store.get(targetId);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }

      const resolved = await deps.resolveProvider(body.provider);
      if (!resolved) { json(res, 400, { error: `Unknown provider "${body.provider}"` }); return; }
      const { adapter: provider, config: resolvedConfig } = resolved;

      const traceId = body.traceId ?? crypto.randomUUID();

      // Normalise content and construct the user message, then persist it so that
      // re-joining this session mid-run shows the in-flight prompt immediately.
      const contentArr = typeof body.content === 'string'
        ? [{ type: 'text' as const, text: body.content }]
        : [body.content];
      const userMsg = createMessage({ role: 'user', content: contentArr, traceId });

      // Auto-title from the first user message
      if (!session.title && !session.messages.some(m => m.role === 'user')) {
        const text = contentArr
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text).join(' ').trim();
        if (text) {
          const words = text.split(/\s+/).slice(0, 8).join(' ');
          session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
        }
      }

      session = appendMessage(session, userMsg);
      await deps.store.set(session.id, session);

      const runConfig = {
        principal: DEFAULT_PRINCIPAL,
        provider:  body.provider,
        traceId,
      };

      const ac = new AbortController();
      req.on('close', () => {
        ac.abort();
        const resolver = pendingPrompts.get(targetId);
        if (resolver) { pendingPrompts.delete(targetId); resolver(''); }
      });

      const active = { subs: new Set<ServerResponse>([res]), buffer: [] as string[], ac };
      activeSessions.set(targetId, active);
      broadcastStatus(targetId, true);

      const broadcast = (s: string): void => {
        active.buffer.push(s);
        for (const sub of active.subs) { if (sub.writable) sub.write(s); }
      };

      const promptFn = (question: string, defaultValue?: string): Promise<string> =>
        new Promise(resolve => {
          pendingPrompts.set(targetId, answer => {
            pendingPrompts.delete(targetId);
            resolve(answer || defaultValue || '');
          });
          broadcast(sseEvent('prompt', {
            type: 'prompt',
            question,
            ...(defaultValue !== undefined ? { defaultValue } : {}),
          }));
        });

      // Switch to SSE
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('stream open'));

      try {
        for await (const event of runSession({
          session,
          config:         runConfig,
          provider,
          providerConfig: resolvedConfig,
          ...(deps.tools         ? { tools: new Map(deps.tools.list().map(t => [t.name, t])) } : {}),
          store:          deps.store,
          ...(deps.hooks         ? { hooks:         deps.hooks         } : {}),
          ...(deps.systemContext ? { systemContext: deps.systemContext } : {}),
          ...(deps.workdir    ? { workdir:    deps.workdir    } : {}),
          ...(deps.files      ? { files:      deps.files      } : {}),
          ...(deps.configPath ? { configPath: deps.configPath } : {}),
          signal:         ac.signal,
          prompt:         promptFn,
          loadPlugin:     deps.loadPlugin,
          unloadPlugin:   deps.unloadPlugin,
        })) {
          broadcast(sseEvent(event.type, event));
        }
      } catch (e) {
        broadcast(sseEvent('error', { type: 'error', error: String(e) }));
      } finally {
        activeSessions.delete(targetId);
        broadcastStatus(targetId, false);
        for (const sub of active.subs) { sub.end(); }
      }
      return;
    }

    // --- GET /sessions/:id/stream ---
    // Lets a second client join an in-progress run with full event replay.
    const streamMatch2 = /^\/sessions\/([^/]+)\/stream$/.exec(url);
    if (method === 'GET' && streamMatch2) {
      const sId    = streamMatch2[1]!;
      const active = activeSessions.get(sId);
      if (!active) { json(res, 404, { error: 'No active stream' }); return; }
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      for (const s of active.buffer) { if (res.writable) res.write(s); }
      active.subs.add(res);
      req.on('close', () => active.subs.delete(res));
      return;
    }

    // --- POST /sessions/:id/abort ---
    const abortMatch = /^\/sessions\/([^/]+)\/abort$/.exec(url);
    if (method === 'POST' && abortMatch) {
      const sId    = abortMatch[1]!;
      const active = activeSessions.get(sId);
      if (!active) { json(res, 404, { error: 'No active session' }); return; }
      active.ac.abort();
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
      let body: { answer: string };
      try { body = JSON.parse(await readBody(req)) as { answer: string }; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const resolver = pendingPrompts.get(sId);
      if (!resolver) { json(res, 409, { error: 'No pending prompt for this session' }); return; }
      resolver(body.answer ?? '');
      json(res, 200, { ok: true });
      return;
    }

    // --- GET /workspace/events --- (SSE: all workspace file-change events)
    if (method === 'GET' && url === '/workspace/events') {
      if (!deps.files?.watch) { json(res, 404, { error: 'File watch not available' }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write(sseComment('workspace watch stream open'));
      workspaceEventListeners.add(res);
      req.on('close', () => workspaceEventListeners.delete(res));
      return;
    }

    // --- GET /workspace/events/<path> --- (SSE: single-file watch)
    const workspaceEventMatch = /^\/workspace\/events\/(.+)$/.exec(url);
    if (method === 'GET' && workspaceEventMatch) {
      if (!deps.files?.watch) { json(res, 404, { error: 'File watch not available' }); return; }
      let watchPath: string;
      try { watchPath = decodeURIComponent(workspaceEventMatch[1]!); }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write(sseComment(`watching ${watchPath}`));

      let subs = fileEventListeners.get(watchPath);
      if (subs === undefined) { subs = new Set(); fileEventListeners.set(watchPath, subs); }
      subs.add(res);
      req.on('close', () => {
        const s = fileEventListeners.get(watchPath);
        if (s) { s.delete(res); if (s.size === 0) fileEventListeners.delete(watchPath); }
      });
      return;
    }

    // --- GET /workspace/:path --- (read-only static access to the session workspace)
    const workspaceMatch = /^\/workspace\/(.+)$/.exec(url);
    if (method === 'GET' && workspaceMatch && deps.files) {
      let reqPath: string;
      try { reqPath = decodeURIComponent(workspaceMatch[1]!); }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      const handle = await deps.files.getByName(reqPath, 'workspace');
      if (!handle) { json(res, 404, { error: 'Not found' }); return; }

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
    // Abort and drain all active streaming sessions.
    for (const active of activeSessions.values()) {
      active.ac.abort();
      for (const sub of active.subs) sub.end();
    }
    activeSessions.clear();

    // Close all status stream connections.
    for (const res of statusListeners) res.end();
    statusListeners.clear();

    // Stop file watcher and close all watch SSE connections.
    watchAc.abort();
    for (const res of workspaceEventListeners) res.end();
    workspaceEventListeners.clear();
    for (const subs of fileEventListeners.values()) for (const res of subs) res.end();
    fileEventListeners.clear();

    // Resolve all pending prompts so callers don't hang.
    for (const resolver of pendingPrompts.values()) resolver('');
    pendingPrompts.clear();

    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve())),
    );
  }

  return { server, close };
}
