import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// The client half of the same defect. `sessionEvents` reconnects, but a reconnect is not a
// continuation: the server replays the RUNNING turn and says nothing about a turn that began and ended
// while the stream was gone — so a caller holding per-turn render state (app.js's turnQueues) shows
// loading dots for a turn that finished minutes ago, until a page refresh. The transport therefore
// announces the discontinuity as a synthetic `stream-resumed`, which is the only moment the caller can
// know to reconcile against committed history.
//
// The watchdog is the other half: a socket killed by sleep or a network change leaves `reader.read()`
// pending with no error, so the reconnect loop below never gets to run at all. Bounding the silence is
// what turns an undetectable death into a reconnect.

// The page-lifecycle listeners the transport registers, so a test can fire them.
const listeners = new Map<string, Array<() => void>>();
function fire(name: string): void { for (const fn of listeners.get(name) ?? []) fn(); }

/** Fire an event as though a long time had passed, without waiting for it. `reviveStale` reads the clock
 *  synchronously, so skewing it for the duration of the dispatch is enough and stubs nothing else. */
function fireAfterSilence(name: string, ms: number): void {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { fire(name); } finally { Date.now = realNow; }
}

/** Load static/http-transport.js — browser globals stubbed, relative URLs pointed at `base`. */
async function loadTransport(base: string): Promise<{
  sessionEvents(sid: string, signal: AbortSignal): AsyncIterable<{ type: string }>;
}> {
  const g = globalThis as unknown as Record<string, unknown>;
  const realFetch = globalThis.fetch;
  listeners.clear();
  const addEventListener = (name: string, fn: () => void): void => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  };
  g['window']           = g;
  g['addEventListener'] = addEventListener;
  g['document']         = { getElementById: () => null, addEventListener, visibilityState: 'visible' };
  g['localStorage']     = { getItem: () => null, setItem: () => {} };
  g['location']         = { reload: () => {} };
  g['fetch']            = (url: string, opts?: RequestInit) =>
    realFetch(url.startsWith('/') ? base + url : url, opts);
  const url = new URL('../../../plugins/frontend/web/static/http-transport.js', import.meta.url);
  await import(`${url.href}?t=${process.hrtime.bigint()}`);
  return g['matbotTransport'] as Awaited<ReturnType<typeof loadTransport>>;
}

test('a reconnect is announced, so the caller knows to reconcile', { timeout: 20000 }, async () => {
  let connects = 0;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/events/sessions/')) { res.writeHead(404).end(); return; }
    connects++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    res.write(`event: text-delta\ndata: ${JSON.stringify({ type: 'text-delta', n: connects })}\n\n`);
    // First connection dies mid-turn, as a proxy or a sleeping laptop does; the next one stays up.
    if (connects === 1) res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const T = await loadTransport(base);
    const ac = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const ev of T.sessionEvents('s1', ac.signal)) {
        seen.push(ev.type);
        if (seen.length === 3) { ac.abort(); return; }
      }
    })();
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`saw ${seen.join(', ')}`)), 8000))]);

    assert.deepEqual(seen, ['text-delta', 'stream-resumed', 'text-delta']);
    assert.equal(connects, 2);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('the first connect announces nothing — it is the caller\'s own starting point', { timeout: 20000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    res.write(`event: queued\ndata: ${JSON.stringify({ type: 'queued' })}\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const T = await loadTransport(base);
    const ac = new AbortController();
    const seen: string[] = [];
    for await (const ev of T.sessionEvents('s1', ac.signal)) { seen.push(ev.type); ac.abort(); break; }
    assert.deepEqual(seen, ['queued']);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('becoming visible revives a quiet stream without waiting out the watchdog', { timeout: 20000 }, async () => {
  let connects = 0;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/events/sessions/')) { res.writeHead(404).end(); return; }
    connects++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    res.write(`event: text-delta\ndata: ${JSON.stringify({ type: 'text-delta', n: connects })}\n\n`);
    // Then silence — a stream that looks alive to the OS and is delivering nothing.
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const T = await loadTransport(base);
    const ac = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const ev of T.sessionEvents('s1', ac.signal)) {
        seen.push(ev.type);
        if (seen.length === 3) { ac.abort(); return; }
      }
    })();

    // Waiting out a real 25s of silence is not a test, so the event is dispatched as though it had
    // elapsed. The watchdog's own 65s deadline must NOT be what recovers this.
    await new Promise(r => setTimeout(r, 200));
    fireAfterSilence('visibilitychange', 20 * 60 * 1000);

    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`saw ${seen.join(', ')}`)), 6000))]);
    assert.deepEqual(seen, ['text-delta', 'stream-resumed', 'text-delta']);
    assert.equal(connects, 2, 'becoming visible reconnected the quiet stream');
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('becoming visible leaves a stream that is still delivering alone', { timeout: 20000 }, async () => {
  let connects = 0;
  const server = createServer((req, res) => {
    connects++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    res.write(`event: queued\ndata: ${JSON.stringify({ type: 'queued' })}\n\n`);
    // Keep beating, as a healthy server does.
    const beat = setInterval(() => { if (res.writable) res.write(': hb\n\n'); }, 40);
    res.on('close', () => clearInterval(beat));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const T = await loadTransport(base);
    const ac = new AbortController();
    const seen: string[] = [];
    void (async () => { for await (const ev of T.sessionEvents('s1', ac.signal)) seen.push(ev.type); })();
    await new Promise(r => setTimeout(r, 300));
    // A hidden tab whose stream survived needs no recovery, and recovery costs the caller a re-read —
    // so a foreground switch on a live stream must be a no-op, not a reconnect. `pageshow` too: a
    // bfcache restore of a page whose stream is still delivering is not a reason to rebuild anything.
    fire('visibilitychange'); fire('pageshow'); fire('visibilitychange');
    await new Promise(r => setTimeout(r, 300));
    ac.abort();
    assert.equal(connects, 1, 'a live stream must not be torn down');
    assert.deepEqual(seen, ['queued'], 'and no resume announced');
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});
