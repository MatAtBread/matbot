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
//   submit(sid, { content, provider, concatQueue, mode }) -> Promise<{ queued, traceId }>  (throws on failure)
//   sessionEvents(sid, signal)                     -> AsyncIterable<PipelineEvent>   all turn output for the session
//   answerPrompt(sid, body)                        -> Promise<void>    body = { answer } | { cancel: true }
//   answerEnv(sid, body)                           -> Promise<void>    body = { callId, ok, value } | { callId, ok:false, error }
//   abort(sid)                                     -> Promise<void>
//   statusEvents(signal)                           -> AsyncIterable<{ sessionId, busy }>
//   notifications(signal)                          -> AsyncIterable<Notification>
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
  // Every response carries the serving harness version as `x-matbot-version`. The version this page
  // loaded against is the one already on screen — app.js writes `about_matbot`'s version into
  // #matbot-version at bootstrap — so that element IS the baseline; nothing extra is stamped anywhere.
  // When the server is restarted on a new version under a long-lived tab the two diverge, and the page
  // reloads rather than keep running UI code against an API it no longer matches. Read lazily, not
  // captured: it is filled asynchronously during bootstrap, and until then there is no baseline to
  // compare (the header is simply ignored).
  let reloading = false;
  function checkVersion(res) {
    if (reloading) return;
    const loaded = document.getElementById('matbot-version')?.textContent?.replace(/^v/, '') || '';
    const served = res.headers.get('x-matbot-version');
    if (!loaded || !served || served === loaded) return;
    // Guard the pathological case of a reload landing on the old version again — reload at most once.
    reloading = true;
    console.warn('[matbot] server version ' + served + ' != loaded ' + loaded + ' — reloading');
    location.reload();
  }

  function apiFetch(url, opts) {
    const o = opts || {};
    const headers = withProfile(o.headers);
    return fetch(url, headers ? { ...o, headers } : o).then(res => { checkVersion(res); return res; });
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

  // A dead socket is indistinguishable from a quiet one, and a long turn is very quiet: `reader.read()`
  // simply never settles, no error is thrown, and the reconnect below never gets a chance to run — the
  // tab sits on a stream that ended minutes ago. So bound the silence: past three heartbeats it is dead
  // rather than idle, and anything shorter than one beat is proof of life — which makes that also the
  // test for "did this stream survive being hidden?" (see the page-lifecycle hooks below).
  //
  // Both derive from the server's beat, which it reports at /ui-config, because a silence threshold is
  // only meaningful relative to how often the other end speaks. They were two constants in two files kept
  // consistent by hand, so changing the server's interval silently made the client wrong — and wrong here
  // means tearing down a healthy stream on every deadline. Fetched once, in flight before anything opens a
  // stream and never awaited: the defaults suit the default server, and the numbers do not matter for 20s.
  let heartbeatMs = 20000;
  fetch('/ui-config')
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => { if (cfg && typeof cfg.heartbeatMs === 'number' && cfg.heartbeatMs > 0) heartbeatMs = cfg.heartbeatMs; })
    .catch(() => { /* an older server, or none — the defaults stand */ });
  const streamIdleMs  = () => heartbeatMs * 3 + 5000;
  const streamFreshMs = () => heartbeatMs + 5000;

  // Page lifecycle. A hidden tab may keep its connections (usually does, on desktop) or lose them
  // silently, and the difference is not knowable in advance — so ask on the way back rather than
  // guessing on the way out. Deliberately NOT a disconnect-on-hide policy: a stream that survived needs
  // no recovery at all, and recovery costs the caller a re-read, so making the gap certain would make
  // that cost certain too. Only a stream that has gone quiet is torn down, which drops the wait for the
  // idle watchdog from three heartbeats to the moment the user looks at the tab.
  //
  // BOTH events, because they answer different questions. `visibilitychange` covers tab switching and
  // app backgrounding. `pageshow` covers the back/forward cache, where the page is restored without its
  // scripts re-running and its streams gone — Safari leans on bfcache heavily, and mobile Safari also
  // freezes JS outright while hidden, so the timer below cannot be the only mechanism there.
  const liveStreams = new Set();   // { lastByteAt, revive } per open session stream
  const reviveStale = () => {
    const now = Date.now();
    for (const st of liveStreams) if (now - st.lastByteAt > streamFreshMs()) st.revive();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reviveStale();
    });
    window.addEventListener('pageshow', reviveStale);
  }

  // One persistent GET /events/sessions/:id carrying ALL turns for the session, demuxed by the
  // caller. Reconnects with a 1s backoff until `signal` aborts.
  //
  // Each RECONNECT yields a synthetic `{ type: 'stream-resumed' }` first. A reconnect is not a
  // continuation: the stream replays the running turn, and says nothing about turns that began and
  // ended while it was gone — so a caller holding per-turn render state has to reconcile against
  // committed history, and this is the only moment it can know to. The first connect yields nothing,
  // being the caller's own starting point.
  async function* sessionEvents(sid, signal) {
    let connected = false;
    while (!signal.aborted) {
      try {
        const res = await apiFetch('/events/sessions/' + sid, { signal });
        if (!res.ok || !res.body) break;
        if (connected) yield { type: 'stream-resumed' };
        connected = true;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        // Registered for the page-lifecycle sweep: `revive` resolves the same race the watchdog does,
        // so becoming visible on a quiet stream takes the identical reconnect path a timeout would.
        let wake;
        // Declared out here so the `finally` can clear a race we never settled: a consumer that stops
        // iterating closes this generator mid-`await`, and a deadline left pending then outlives the
        // stream it was guarding.
        let timer;
        const state = { lastByteAt: Date.now(), revive: () => wake?.('idle') };
        liveStreams.add(state);
        try {
          while (true) {
            // A timeout wins the race only when nothing at all arrived, heartbeat included. Cancelling
            // the reader settles the read we walked away from.
            const idle = new Promise(r => {
              wake = r;
              timer = setTimeout(() => r('idle'), streamIdleMs());
            });
            const next = await Promise.race([reader.read(), idle]);
            clearTimeout(timer);
            if (next === 'idle') { await reader.cancel().catch(() => {}); break; }
            const { done, value } = next;
            if (done) break;
            if (signal.aborted) { reader.cancel(); break; }
            state.lastByteAt = Date.now();
            buf += dec.decode(value, { stream: true });
            const parsed = parseSSEChunk(buf);
            buf = parsed.remaining;
            for (const ev of parsed.events) yield ev;
          }
        } finally {
          liveStreams.delete(state);
          clearTimeout(timer);
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

  // session-busy stays its own event: it is transient state, replayed on connect, not a durable fact —
  // exactly what the notification bus deliberately does not carry.
  function statusEvents(signal) { return globalEventStream('session-busy', signal); }
  // Everything else — file/skill/session/share changes and tool/plugin registry churn — arrives as one
  // notification stream, already filtered server-side to what this connection's principal may see.
  function notifications(signal) { return globalEventStream('notification', signal); }

  function openFile(namespace, path) {
    const profileName = currentProfile();
    window.open('/files/' + (profileName ? '~' + profileName + '/' : '') + namespace + '/' + path, '_blank');
  }

  window.matbotTransport = {
    hostRuntime: 'node',
    callTool, createSession, sessionBusy, submit,
    sessionEvents, answerPrompt, answerEnv, abort, statusEvents, notifications, openFile,
  };
})();
