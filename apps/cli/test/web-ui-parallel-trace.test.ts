import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

// A parallel turn runs on a COPY of the session, so the web UI must never redraw the page from the
// `session` its terminal carries. It knows a trace is parallel from `parallelTraces`, which `merged` used
// to clear on arrival. When nothing else is running, a parallel turn's `done` and its `merged` can arrive
// in one chunk, both pushed before its renderer has handled the `done`. By then the renderer no longer
// knew the turn was parallel, and wiped the page and redrew it from the copy, hidden framing note
// included.
//
// app.js is a plain browser script, so the stream demux is lifted out of it verbatim and run with the
// renderer stubbed. A rename that breaks the slice fails here loudly rather than silently testing nothing.

const source = readFileSync(join(import.meta.dirname, '..', '..', '..', 'plugins', 'frontend', 'web', 'static', 'app.js'), 'utf8');
const from = source.indexOf('let streamSessionId = null;');
const to   = source.indexOf('// Re-read the conversation from the server and rebind its stream');
assert.ok(from > 0 && to > from, 'the stream demux block was found in app.js');

function demux() {
  const seen: Array<{ type: string; parallel: boolean }> = [];
  const ctx = createContext({
    appendMarker: () => {},
    // What renderTurn asks at each event: is this trace a parallel one?
    renderTurn: async (_sid: string, traceId: string) => {
      for await (const ev of (ctx.turnEvents as (t: string) => AsyncIterable<{ type: string }>)(traceId)) {
        seen.push({ type: ev.type, parallel: (ctx.isParallel as (t: string) => boolean)(traceId) });
      }
    },
  });
  runInContext(`${source.slice(from, to)}\nthis.turnEvents = turnEvents; this.push = pushTurnEvent; this.isParallel = t => parallelTraces.has(t);`, ctx);
  return { push: ctx.push as (ev: object) => void, seen };
}

test('a parallel turn\'s renderer still knows it is parallel at its terminal, though `merged` came with it', async () => {
  const { push, seen } = demux();
  push({ type: 'parallel', traceId: 'p', runningTraceId: 'm', content: [] });
  push({ type: 'text-delta', traceId: 'p', delta: 'A' });
  // One chunk: both pushed before the renderer has run.
  push({ type: 'done', traceId: 'p', session: { messages: [] } });
  push({ type: 'merged', traceId: 'p' });
  await new Promise(r => setImmediate(r));

  const done = seen.find(e => e.type === 'done');
  assert.ok(done, 'the renderer saw the terminal');
  assert.equal(done.parallel, true, 'and still knew the trace was parallel');
  assert.ok(!seen.some(e => e.type === 'merged'), '`merged` spawns no renderer of its own');
});

test('an ordinary turn is not marked parallel', async () => {
  const { push, seen } = demux();
  push({ type: 'text-delta', traceId: 't', delta: 'A' });
  push({ type: 'done', traceId: 't', session: { messages: [] } });
  await new Promise(r => setImmediate(r));
  assert.equal(seen.find(e => e.type === 'done')?.parallel, false);
});
