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

/** Load static/http-transport.js — browser globals stubbed, relative URLs pointed at `base`. */
async function loadTransport(base: string): Promise<{
  sessionEvents(sid: string, signal: AbortSignal): AsyncIterable<{ type: string }>;
}> {
  const g = globalThis as unknown as Record<string, unknown>;
  const realFetch = globalThis.fetch;
  g['window']       = g;
  g['document']     = { getElementById: () => null };
  g['localStorage'] = { getItem: () => null, setItem: () => {} };
  g['location']     = { reload: () => {} };
  g['fetch']        = (url: string, opts?: RequestInit) =>
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
