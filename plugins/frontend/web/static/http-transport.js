// HTTP transport for the matbot web UI.
//
// Sets `window.matbotTransport` to an implementation that talks to the Node web server (server.ts)
// over fetch + SSE. The in-process browser bundle substitutes a different script (browser.js) that
// satisfies the SAME contract, so app.js is byte-identical in both delivery modes.
//
// Contract — `window.matbotTransport`:
//   hostRuntime                                    -> 'node' | 'browser'  which runtime the UI is on
//   callTool(name, input)                          -> Promise<any>     buffered tool call (throws on error)
//   createSession()                                -> Promise<{ id }>
//   sessionBusy(id)                                -> Promise<boolean>
//   submit(sid, { content, provider, concatQueue }) -> Promise<{ queued, traceId }>  (throws on failure)
//   sessionEvents(sid, signal)                     -> AsyncIterable<PipelineEvent>   all turn output for the session
//   answerPrompt(sid, body)                        -> Promise<void>    body = { answer } | { cancel: true }
//   answerEnv(sid, body)                           -> Promise<void>    body = { callId, ok, value } | { callId, ok:false, error }
//   abort(sid)                                     -> Promise<void>
//   statusEvents(signal)                           -> AsyncIterable<{ sessionId, busy }>
//   fileEvents(signal)                             -> AsyncIterable<{ namespace, name, size }>
//   skillEvents(signal)                            -> AsyncIterable<{ type: 'saved'|'deleted', name }>
//   openFile(namespace, path)                      -> void

(function () {
  // Split a growing SSE buffer into complete events, returning the unparsed tail. `data:` lines only.
  function parseSSEChunk(text) {
    const events = [];
    const blocks = text.split('\n\n');
    const remaining = blocks.pop() ?? '';
    for (const block of blocks) {
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (data) {
        try { events.push(JSON.parse(data)); } catch { /* skip malformed */ }
      }
    }
    return { events, remaining };
  }

  // The active profile is a per-browser choice (the profile selector stores it here); when set it rides
  // every API request as `x-matbot-principal`, so the server routes the request — and its session/tool
  // storage — to that profile. Absent ⇒ no header ⇒ the server's default (boot) principal, i.e. base
  // storage, so a vanilla UI with no profile chosen behaves exactly as before. The global /events
  // EventSource can't set a header (the browser API has none), so it carries the same choice as a
  // `?principal=` query param — the server filters that connection's partitioned file events by it.
  const PROFILE_KEY = 'matbot.profile';
  function currentProfile() { try { return localStorage.getItem(PROFILE_KEY) || null; } catch { return null; } }
  function withProfile(headers) {
    const p = currentProfile();
    return p ? { ...(headers || {}), 'x-matbot-principal': p } : (headers || undefined);
  }
  function apiFetch(url, opts) {
    const o = opts || {};
    const headers = withProfile(o.headers);
    return fetch(url, headers ? { ...o, headers } : o);
  }

  async function callTool(toolName, input) {
    const res = await apiFetch('/tools/' + toolName, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('HTTP ' + res.status + (data.error ?? ''));
    return data;
  }

  async function createSession() {
    const r = await apiFetch('/sessions', { method: 'POST' });
    return r.json();
  }

  async function sessionBusy(id) {
    try {
      const r = await apiFetch('/sessions/' + id);
      return r.ok ? (await r.json()).busy : false;
    } catch { return false; }
  }

  // Fire-and-forget enqueue: the turn's output arrives over sessionEvents(), not here. Throws on a
  // non-2xx or a transport failure (incl. the 20s timeout) so the caller can surface it inline.
  async function submit(sid, body) {
    const res = await apiFetch('/sessions/' + sid + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return res.json().catch(() => ({}));
  }

  // One persistent GET /events/sessions/:id carrying ALL turns for the session, demuxed by the
  // caller. Reconnects with a 1s backoff until `signal` aborts.
  async function* sessionEvents(sid, signal) {
    while (!signal.aborted) {
      try {
        const res = await apiFetch('/events/sessions/' + sid, { signal });
        if (!res.ok || !res.body) break;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) { reader.cancel(); break; }
          buf += dec.decode(value, { stream: true });
          const parsed = parseSSEChunk(buf);
          buf = parsed.remaining;
          for (const ev of parsed.events) yield ev;
        }
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async function answerPrompt(sid, body) {
    await apiFetch('/sessions/' + sid + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function answerEnv(sid, body) {
    await apiFetch('/sessions/' + sid + '/env-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function abort(sid) {
    await apiFetch('/sessions/' + sid + '/abort', { method: 'POST' });
  }

  // All global (non-session) event types share ONE EventSource to /events, demuxed by event name and
  // fanned out to per-event-name subscriber sets. Browsers cap HTTP/1.1 at ~6 sockets per host; a
  // stream per panel (status/files/tools/plugins/skills) would exhaust that and starve ordinary fetches
  // (the sidebar load, tool calls). The connection opens on first subscribe and reconnects on error with
  // a 3s backoff; subscriber sets persist across reconnects, and every name is re-bound onto the new
  // EventSource, so no listener is dropped.
  const globalSubs = new Map(); // eventName -> Set<(data) => void>
  let globalES = null;

  function bindGlobalEvent(es, name) {
    es.addEventListener(name, e => {
      const subs = globalSubs.get(name);
      if (!subs) return;
      let data; try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of subs) fn(data);
    });
  }

  function ensureGlobalStream() {
    if (globalES) return;
    const p = currentProfile();
    const es = new EventSource('/events' + (p ? '?principal=' + encodeURIComponent(p) : ''));
    globalES = es;
    for (const name of globalSubs.keys()) bindGlobalEvent(es, name);
    es.onerror = () => { es.close(); if (globalES === es) globalES = null; setTimeout(ensureGlobalStream, 3000); };
  }

  // One typed view onto the shared stream: yields only `eventName` payloads. Same async-iterable shape
  // and 3s-reconnect resilience the UI had with a stream per type, now over a single socket. Runs for
  // the page lifetime (the UI never aborts these); `signal` is honoured if provided.
  function globalEventStream(eventName, signal) {
    return (async function* () {
      const queue = [];
      let wake = null;
      let closed = false;
      const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
      let subs = globalSubs.get(eventName);
      if (!subs) { subs = new Set(); globalSubs.set(eventName, subs); if (globalES) bindGlobalEvent(globalES, eventName); }
      const push = (data) => { queue.push(data); pump(); };
      subs.add(push);
      if (signal) signal.addEventListener('abort', () => { closed = true; pump(); });
      ensureGlobalStream();
      try {
        while (!closed) {
          while (queue.length) yield queue.shift();
          if (closed) break;
          await new Promise(r => { wake = r; });
        }
      } finally { subs.delete(push); }
    })();
  }

  function statusEvents(signal) { return globalEventStream('session-busy',   signal); }
  function fileEvents(signal)   { return globalEventStream('file-changed',   signal); }
  function toolEvents(signal)   { return globalEventStream('tool-changed',   signal); }
  function pluginEvents(signal) { return globalEventStream('plugin-changed', signal); }
  function skillEvents(signal)  { return globalEventStream('skill-changed',  signal); }

  function openFile(namespace, path) {
    const profileName = currentProfile();
    window.open('/files/' + (profileName ? '~' + profileName + '/' : '') + namespace + '/' + path, '_blank');
  }

  window.matbotTransport = {
    hostRuntime: 'node',
    callTool, createSession, sessionBusy, submit,
    sessionEvents, answerPrompt, answerEnv, abort, statusEvents, fileEvents, toolEvents, pluginEvents, skillEvents, openFile,
  };
})();
