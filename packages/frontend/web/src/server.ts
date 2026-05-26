import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  HookRegistry, Principal, ProviderAdapter, ProviderConfig,
  Session, Store, ToolContext, ToolRegistry, Vault,
} from '@matbot/core';
import { createSession, runSession } from '@matbot/core';
import { sseComment, sseEvent } from '@matbot/frontend-base';
import { html, js } from './ui.js';

export interface WebServerDeps {
  store:       Store<Session>;
  providers:   Map<string, ProviderAdapter>;    // adapter name → adapter
  configs:     Map<string, ProviderConfig>;     // provider config name → config
  vault:       Vault;
  loadPlugin:  (specifier: string) => Promise<void>;
  tools?:      ToolRegistry;
  hooks?:      HookRegistry;
  cors?:       string;  // Access-Control-Allow-Origin value, default '*'
  workdir?:    string;  // default working directory for tool execution
}

interface SubmitBody {
  content:     string | { type: 'form-response'; values: Record<string, string> };
  principal:   Principal;
  provider:    string;       // key into deps.configs
  sessionId?:  string;
  traceId?:    string;
}

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

function sessionPreview(session: Session): string {
  const first = session.messages.find(m => m.role === 'user');
  const text  = first?.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )?.text ?? '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function createWebServer(deps: WebServerDeps) {
  const origin         = deps.cors ?? '*';
  const activeSessions = new Set<string>(); // session IDs with an active SSE stream
  const pendingPrompts = new Map<string, (answer: string) => void>(); // session ID → resolver

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url    = req.url ?? '/';

    // Set CORS headers on every response
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.setHeader(k, v);
    }

    if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

    // --- Static UI ---
    if (method === 'GET' && url === '/')       { static200(res, 'text/html; charset=utf-8',              html); return; }
    if (method === 'GET' && url === '/app.js') { static200(res, 'application/javascript; charset=utf-8', js);   return; }

    // --- GET /health ---
    if (method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok' }); return;
    }

    // --- GET /providers ---
    if (method === 'GET' && url === '/providers') {
      json(res, 200, [...deps.configs.keys()]); return;
    }

    // --- GET /sessions ---
    if (method === 'GET' && url === '/sessions') {
      const { items } = await deps.store.query({
        filter: { field: 'status', op: 'neq', value: 'archived' },
      });
      const sorted = items
        .slice()
        .sort((a, b) => b.doc.updatedAt.localeCompare(a.doc.updatedAt));
      json(res, 200, sorted.map(({ doc: s }) => ({
        id:        s.id,
        title:     s.title,
        preview:   sessionPreview(s),
        updatedAt: s.updatedAt,
      })));
      return;
    }

    // --- GET /sessions/:id ---
    const sessionGetMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && sessionGetMatch) {
      const session = await deps.store.get(sessionGetMatch[1]!);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }
      json(res, 200, session);
      return;
    }

    // --- POST /sessions ---
    if (method === 'POST' && url === '/sessions') {
      let body: { principal: Principal };
      try { body = JSON.parse(await readBody(req)) as { principal: Principal }; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const session = createSession({ ownerPrincipal: body.principal });
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

      const providerConfig = deps.configs.get(body.provider);
      if (!providerConfig) { json(res, 400, { error: `Unknown provider "${body.provider}"` }); return; }

      // Resolve credential placeholders through the vault
      const resolvedCreds: Record<string, string> = {};
      for (const [k, v] of Object.entries(providerConfig.credentials)) {
        resolvedCreds[k] = await deps.vault.resolve(v);
      }
      const resolvedConfig: ProviderConfig = { ...providerConfig, credentials: resolvedCreds };

      const provider = deps.providers.get(resolvedConfig.type);
      if (!provider) { json(res, 400, { error: `No adapter for type "${resolvedConfig.type}"` }); return; }

      const inbound = {
        id:      crypto.randomUUID(),
        content: typeof body.content === 'string' ? body.content : [body.content],
      };

      const runConfig = {
        principal:  body.principal,
        provider:   body.provider,
        ...(body.traceId ? { traceId: body.traceId } : {}),
      };

      const ac = new AbortController();
      req.on('close', () => {
        ac.abort();
        const resolver = pendingPrompts.get(targetId);
        if (resolver) { pendingPrompts.delete(targetId); resolver(''); }
      });

      const promptFn = (question: string, defaultValue?: string): Promise<string> =>
        new Promise(resolve => {
          pendingPrompts.set(targetId, answer => {
            pendingPrompts.delete(targetId);
            resolve(answer || defaultValue || '');
          });
          if (res.writable) {
            res.write(sseEvent('prompt', {
              type: 'prompt',
              question,
              ...(defaultValue !== undefined ? { defaultValue } : {}),
            }));
          }
        });

      // Switch to SSE
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('stream open'));

      activeSessions.add(targetId);
      try {
        for await (const event of runSession({
          inbound,
          session,
          config:         runConfig,
          provider,
          providerConfig: resolvedConfig,
          ...(deps.tools    ? { tools: new Map(deps.tools.list().map(t => [t.name, t])) } : {}),
          store:          deps.store,
          ...(deps.hooks    ? { hooks: deps.hooks }       : {}),
          ...(deps.workdir  ? { workdir: deps.workdir }   : {}),
          signal:         ac.signal,
          prompt:         promptFn,
          loadPlugin:     deps.loadPlugin,
        })) {
          if (!res.writable) break;
          res.write(sseEvent(event.type, event));

          // Persist the updated session when we receive the 'done' event
          if (event.type === 'done') {
            await deps.store.set(event.session.id, event.session);
          }
        }
      } catch (e) {
        if (res.writable) {
          res.write(sseEvent('error', { type: 'error', error: String(e) }));
        }
      } finally {
        activeSessions.delete(targetId);
        res.end();
      }
      return;
    }

    // --- GET /sessions/:id/busy ---
    const busyMatch = /^\/sessions\/([^/]+)\/busy$/.exec(url);
    if (method === 'GET' && busyMatch) {
      json(res, 200, { busy: activeSessions.has(busyMatch[1]!) });
      return;
    }

    // --- POST /tools/:name ---
    const toolCallMatch = /^\/tools\/([^/]+)$/.exec(url);
    if (method === 'POST' && toolCallMatch) {
      const toolName = toolCallMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let body: { input: unknown; principal: Principal };
      try { body = JSON.parse(raw) as { input: unknown; principal: Principal }; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const tool = deps.tools?.resolve(toolName);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      if (tool.requires?.length) {
        const granted = tool.requires.every(cap =>
          body.principal.grants.some(g => g.capability === cap),
        );
        if (!granted) { json(res, 403, { error: `Capability required: ${tool.requires.join(', ')}` }); return; }
      }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('tool stream open'));

      const now         = new Date().toISOString();
      const stubSession: Session = {
        id: crypto.randomUUID(), version: crypto.randomUUID(),
        ownerPrincipalId: body.principal.id,
        status: 'active', contexts: [], messages: [],
        createdAt: now, updatedAt: now,
      };

      const toolCtx: ToolContext = {
        callId:     crypto.randomUUID(),
        session:    stubSession,
        principal:  body.principal,
        signal:     ac.signal,
        loadPlugin: deps.loadPlugin,
        prompt:     (q, def) => def !== undefined
          ? Promise.resolve(def)
          : Promise.reject(new Error(`Non-interactive context: "${q}"`)),
      };

      try {
        for await (const ev of tool.executor.execute(body.input, toolCtx)) {
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

    json(res, 404, { error: 'Not found' });
  });

  return server;
}
