// In-process provider for the matbot web UI (browser bundle side).
//
// The browser counterpart of http-transport.js + server.ts: it sets `window.matbotTransport` to an
// implementation that drives `services.run` / `services.tools` directly (no HTTP, no wire), then
// mounts the *same* index.html scaffold + app.js that Node serves. app.js is byte-identical in both
// modes; only the transport behind `window.matbotTransport` differs.
//
// Resolved by the assembler via the `browser` export condition (frontend/web/package.json), so this
// file — not server.ts — is what enters the browser graph. Never served raw by Node.
//
// The in-process transport is server.ts re-expressed without HTTP: per-session subscribe, the busy
// tracker, prompt parking, and the buffered tool-call ctx, all ported faithfully.

import { createSession, currentPrincipal, PromptCancelledError } from '@matatbread/matbot-core';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// ── In-process transport ──────────────────────────────────────────────────────

function makeInProcessTransport(services) {
  const run = services.run;

  // sid → the parked prompt's settlers (mirror server.ts pendingPrompts). resolve applies the
  // default fallback; cancel rejects with PromptCancelledError (the "give up" path).
  const pendingPrompts = new Map();
  // sid → set of live sessionEvents() injectors, so a turn's promptFn can push a synthetic `prompt`
  // event into whatever stream the UI is currently draining (mirror server.ts sendToSession).
  const hubs = new Map();
  function hub(sid) {
    let h = hubs.get(sid);
    if (h === undefined) { h = new Set(); hubs.set(sid, h); }
    return h;
  }

  // Authoritative busy from the runner (running || queued > 0), deduped + broadcast to statusEvents
  // subscribers (mirror server.ts updateBusy / statusListeners / busyState).
  const statusListeners = new Set();
  const busyState = new Map();
  const busyTrackers = new Set();
  function updateBusy(sid) {
    const busy = run.status(sid).busy;
    if ((busyState.get(sid) ?? false) === busy) return;
    if (busy) busyState.set(sid, true); else busyState.delete(sid);
    for (const l of statusListeners) l({ sessionId: sid, busy });
  }

  // The single interactive prompt implementation for direct tool calls has no answer channel, so it
  // can't prompt — take the offered default or fail loudly (mirror server.ts nonInteractivePrompt).
  const nonInteractivePrompt = (p, def) => {
    const fallback = typeof p === 'string' ? def : p.default;
    return fallback !== undefined
      ? Promise.resolve(fallback)
      : Promise.reject(new Error(`Non-interactive context (use submit for interactive prompts): "${typeof p === 'string' ? p : p.label}"`));
  };

  function makeToolCtx(ac) {
    const now = new Date().toISOString();
    const stubSession = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      ownerPrincipalId: currentPrincipal().id,
      status: 'active', contexts: [], messages: [],
      createdAt: now, updatedAt: now,
    };
    return {
      callId:       crypto.randomUUID(),
      session:      stubSession,
      signal:       ac.signal,
      vault:        services.vault,
      loadPlugin:   services.loadPlugin.bind(services),
      unloadPlugin: services.unloadPlugin.bind(services),
      prompt:       nonInteractivePrompt,
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    };
  }

  // Two failure modes the UI depends on (see the plan's contract):
  //  - tool not installed → throw with "404"/"not found" so app.js offers the install banner.
  //  - any other failure  → throw without those substrings so app.js reports it instead.
  async function callTool(name, input) {
    const tool = services.tools.resolve(name);
    if (!tool) throw new Error(`Tool "${name}" not found (404)`);
    const ac = new AbortController();
    const ctx = makeToolCtx(ac);
    for await (const ev of tool.executor.execute(input, ctx)) {
      if (ev.type === 'result') return ev.value;
      if (ev.type === 'error')  throw new Error(ev.message);
    }
    throw new Error('Tool returned no result');
  }

  async function createSessionFn() {
    const session = createSession({ ownerPrincipal: currentPrincipal() });
    await services.sessions.set(session.id, session);
    return { id: session.id };
  }

  async function sessionBusy(id) {
    return run.status(id).busy;
  }

  function makePromptFn(sid, traceId) {
    return (p, defaultValue) => new Promise((resolve, reject) => {
      const def = typeof p === 'string' ? defaultValue : p.default;
      pendingPrompts.set(sid, {
        resolve: answer => { pendingPrompts.delete(sid); resolve(answer || def || ''); },
        cancel:  ()     => { pendingPrompts.delete(sid); reject(new PromptCancelledError()); },
      });
      const ev = {
        type: 'prompt',
        traceId,
        question: typeof p === 'string' ? p : p.label,
        ...(def !== undefined ? { defaultValue: def } : {}),
        ...(typeof p === 'string' ? {} : { field: p }),
      };
      for (const inject of hub(sid)) inject(ev);
    });
  }

  // Fire-and-forget enqueue: the turn's output reaches the UI over the separate sessionEvents()
  // subscription, not here (mirror the server's submit handler). The first submit of a busy period
  // owns a tracker that drains its own view to idle, so statusEvents() emits the off transition even
  // when no sessionEvents consumer is attached.
  async function submit(sid, body) {
    const contentArr = typeof body.content === 'string'
      ? [{ type: 'text', text: body.content }]
      : [body.content];
    const traceId = crypto.randomUUID();

    const isTracker = !busyTrackers.has(sid);
    if (isTracker) busyTrackers.add(sid);
    const trackAc = new AbortController();
    try {
      const view = await run.open({
        sessionId:   sid,
        signal:      isTracker ? trackAc.signal : new AbortController().signal,
        content:     contentArr,
        provider:    body.provider,
        principal:   currentPrincipal(),
        prompt:      makePromptFn(sid, traceId),
        traceId,
        concatQueue: body.concatQueue ?? false,
      });
      updateBusy(sid);

      if (isTracker) {
        (async () => {
          try {
            for await (const ev of view.events) {
              updateBusy(sid);
              if (ev.type === 'idle' && !run.status(sid).busy) break;
            }
          } catch { /* stream torn down */ }
          finally { busyTrackers.delete(sid); trackAc.abort(); }
        })();
      }
      return { queued: view.queued, traceId: view.traceId };
    } catch (e) {
      if (isTracker) busyTrackers.delete(sid);
      throw e;
    }
  }

  // One persistent per-session stream carrying ALL turn output, exactly like GET /sessions/:id/events:
  // the runner's events merged with the synthetic `prompt` events promptFn injects. `idle` is runner
  // bookkeeping (drives busy) and is not forwarded — app.js has no case for it.
  async function* sessionEvents(sid, signal) {
    const queue = [];
    let wake = null;
    let done = false;
    const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
    const inject = ev => { queue.push(ev); pump(); };
    hub(sid).add(inject);

    let view;
    try {
      view = await run.open({ sessionId: sid, signal });
    } catch {
      hub(sid).delete(inject);
      return;
    }

    const feed = (async () => {
      try {
        for await (const ev of view.events) {
          if (ev.type === 'idle') { updateBusy(sid); continue; }
          queue.push(ev); pump();
          updateBusy(sid);
        }
      } catch { /* torn down */ }
      finally { done = true; pump(); }
    })();

    if (signal) signal.addEventListener('abort', () => { done = true; pump(); });

    try {
      while (!done || queue.length) {
        while (queue.length) yield queue.shift();
        if (done) break;
        await new Promise(r => { wake = r; });
      }
    } finally {
      const h = hubs.get(sid);
      if (h) { h.delete(inject); if (h.size === 0) hubs.delete(sid); }
      void feed;
    }
  }

  async function answerPrompt(sid, body) {
    const entry = pendingPrompts.get(sid);
    if (!entry) return;
    if (body.cancel) {
      // Give up: reject the prompt (the tool closes its call with an error result) and abandon the
      // turn without disturbing the queue (mirror server.ts).
      entry.cancel();
      run.cancelTurn(sid);
    } else {
      entry.resolve(body.answer ?? '');
    }
  }

  async function abort(sid) {
    // Release any pending prompt first so a turn parked on ctx.prompt() observes the abort rather
    // than hangs, then drop the queue + abort the running turn (mirror server.ts).
    const r = pendingPrompts.get(sid);
    if (r) { pendingPrompts.delete(sid); r.resolve(''); }
    run.abort(sid);
    updateBusy(sid);
  }

  async function* statusEvents(signal) {
    const queue = [];
    let wake = null;
    let closed = false;
    const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
    const l = ev => { queue.push(ev); pump(); };
    statusListeners.add(l);
    // Send current busy state so the client is up-to-date immediately (mirror server.ts).
    for (const sid of [...busyState.keys()]) {
      if (run.status(sid).busy) queue.push({ sessionId: sid, busy: true });
      else updateBusy(sid);
    }
    if (signal) signal.addEventListener('abort', () => { closed = true; pump(); });
    try {
      while (!closed) {
        while (queue.length) yield queue.shift();
        if (closed) break;
        await new Promise(r => { wake = r; });
      }
    } finally { statusListeners.delete(l); }
  }

  async function* fileEvents(signal) {
    if (!services.files || !services.files.watch) return;
    for await (const event of services.files.watch(signal)) yield event;
  }

  // No HTTP file route in-process, so materialise the bytes into a blob: URL (mirror the dom
  // frontend's url_for_resource). Default-deny: only files marked `allowed` get a URL.
  async function openFile(namespace, name) {
    const handle = await services.files?.getByName(name, namespace);
    if (!handle || !handle.allowed) return;
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.stream()) { chunks.push(chunk); total += chunk.byteLength; }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    window.open(URL.createObjectURL(new Blob([bytes], { type: handle.mimeType })), '_blank');
  }

  return {
    hostRuntime: 'browser',
    callTool, createSession: createSessionFn, sessionBusy, submit,
    sessionEvents, answerPrompt, abort, statusEvents, fileEvents, openFile,
  };
}

// ── Mount: inject the baked scaffold + app.js ───────────────────────────────────

function reviveScript(src) {
  const s = document.createElement('script');
  for (const a of src.attributes) s.setAttribute(a.name, a.value);
  s.textContent = src.textContent;
  return s;
}

// Append a (revived) script and resolve when it's ready. External scripts resolve on load/error (so
// an offline file:// CDN miss degrades rather than hangs); inline scripts execute synchronously.
function runScript(src) {
  return new Promise(resolve => {
    const s = reviveScript(src);
    if (s.src) { s.onload = () => resolve(); s.onerror = () => resolve(); document.head.appendChild(s); }
    else { document.head.appendChild(s); resolve(); }
  });
}

async function mountUI() {
  const assets = (globalThis.__MB__ && globalThis.__MB__.assets) || {};
  if (!assets.scaffold || !assets.appJs) {
    console.error('[frontend-web] no baked UI assets (scaffold/appJs) — was the bundle assembled with the assets config?');
    return;
  }
  const doc = new DOMParser().parseFromString(assets.scaffold, 'text/html');

  // 1. Head styles/links (synchronous), keeping the scaffold's look.
  for (const node of doc.head.querySelectorAll('style, link')) document.head.appendChild(node.cloneNode(true));

  // 2. Body markup. Drop the Node-only <script src> tags (they'd 404 in the bundle, and innerHTML
  //    scripts don't execute anyway); app.js is injected as a live script below.
  for (const s of doc.body.querySelectorAll('script[src="/app.js"], script[src="/http-transport.js"]')) s.remove();
  document.getElementById('mb-loading')?.remove();
  document.body.innerHTML = doc.body.innerHTML;

  // 3. Head scripts: marked / tiny-mde from a CDN (http(s) only; offline file:// degrades), plus the
  //    inline font-size restore. Awaited so the libs are ready before app.js' init() runs.
  for (const s of doc.head.querySelectorAll('script')) await runScript(s);

  // 4. app.js last — DOM, transport global, and libs all in place. It runs top-level and init()s.
  const appScript = document.createElement('script');
  appScript.textContent = assets.appJs;
  document.body.appendChild(appScript);
}

export const plugin = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'Browser web frontend (in-process): the served UI, mounted without a server.' },
  async setup(services) {
    services.registerFrontend({ name: 'frontend-web' });
    window.matbotTransport = makeInProcessTransport(services);
    await mountUI();
  },
};
