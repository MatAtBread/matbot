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

  async function callTool(toolName, input) {
    const res = await fetch('/tools/' + toolName, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('HTTP ' + res.status + (data.error ?? ''));
    return data;
  }

  async function createSession() {
    const r = await fetch('/sessions', { method: 'POST' });
    return r.json();
  }

  async function sessionBusy(id) {
    try {
      const r = await fetch('/sessions/' + id);
      return r.ok ? (await r.json()).busy : false;
    } catch { return false; }
  }

  // Fire-and-forget enqueue: the turn's output arrives over sessionEvents(), not here. Throws on a
  // non-2xx or a transport failure (incl. the 20s timeout) so the caller can surface it inline.
  async function submit(sid, body) {
    const res = await fetch('/sessions/' + sid + '/submit', {
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
        const res = await fetch('/events/sessions/' + sid, { signal });
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
    await fetch('/sessions/' + sid + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function abort(sid) {
    await fetch('/sessions/' + sid + '/abort', { method: 'POST' });
  }

  // EventSource wrapped as an async iterable, with the same 3s reconnect-on-error the UI used inline.
  // Runs for the page lifetime (the UI never aborts these); `signal` is honoured if provided.
  function eventStream(url, eventName, signal) {
    return (async function* () {
      const queue = [];
      let wake = null;
      let closed = false;
      let es = null;
      const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
      const connect = () => {
        es = new EventSource(url);
        es.addEventListener(eventName, e => {
          try { queue.push(JSON.parse(e.data)); pump(); } catch { /* skip malformed */ }
        });
        es.onerror = () => { es.close(); if (!closed) setTimeout(() => { if (!closed) connect(); }, 3000); };
      };
      if (signal) signal.addEventListener('abort', () => { closed = true; es?.close(); pump(); });
      connect();
      try {
        while (!closed) {
          while (queue.length) yield queue.shift();
          if (closed) break;
          await new Promise(r => { wake = r; });
        }
      } finally { closed = true; es?.close(); }
    })();
  }

  function statusEvents(signal) { return eventStream('/events/sessions', 'session-busy',   signal); }
  function fileEvents(signal)   { return eventStream('/events/files',    'file-changed',   signal); }
  function toolEvents(signal)   { return eventStream('/events/tools',    'tool-changed',   signal); }
  function pluginEvents(signal) { return eventStream('/events/plugins',  'plugin-changed', signal); }
  function skillEvents(signal)  { return eventStream('/events/skills',   'skill-changed',  signal); }

  function openFile(namespace, path) {
    window.open('/files/' + namespace + '/' + path, '_blank');
  }

  window.matbotTransport = {
    hostRuntime: 'node',
    callTool, createSession, sessionBusy, submit,
    sessionEvents, answerPrompt, abort, statusEvents, fileEvents, toolEvents, pluginEvents, skillEvents, openFile,
  };
})();
