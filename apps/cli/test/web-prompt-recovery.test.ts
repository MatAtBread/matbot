import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, createNotifier,
} from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  FormField, Vault,
} from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// Raising a prompt is ONE fire-and-forget SSE write, so it used to be lost outright whenever the
// session had no live stream at that instant — the user on another conversation, a reloading tab, or a
// socket killed by sleep that nobody had reaped. The turn then parked forever with no prompt anywhere
// on screen, and the "no viewers left" release answered it with the field's DEFAULT, which is an answer
// nobody gave. A prompt is state, not an event: it stays true until answered, so it is parked and
// re-sent to every stream that connects while it is outstanding.
//
// The same gap read the other way round is a turn that "never completes": a stream replays the RUNNING
// turn and nothing else, so one that began and ended during the gap is never mentioned again. That half
// is the client's to reconcile (`stream-resumed` → re-read committed history); what the server owes it
// is a heartbeat, so the drop is detectable at all.

const prompted: string[] = [];
let releaseTool: () => void = () => {};

const confirmTool: Tool = {
  name: 'confirm_install',
  description: 'asks the user out of band',
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute(_input, ctx) {
      const field: FormField = { name: 'confirm', label: 'Install plugin "x"?', type: 'confirm', default: 'no' };
      prompted.push(await ctx.prompt(field));
      yield { type: 'result', value: 'installed' };
    },
  },
};

const slowTool: Tool = {
  name: 'slow',
  description: 'the quiet middle of a long turn',
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute() {
      await new Promise<void>(r => { releaseTool = r; });
      yield { type: 'result', value: 'done' };
    },
  },
};

function boot(tool: Tool) {
  const session = createSession();
  const docs = new Map<string, Session>([[session.id, session]]);
  const store = {
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, v: Session) => { docs.set(id, v); },
    cas:    async (id: string, _v: string, next: Session) => { docs.set(id, next); return next; },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<Session>;

  const tools = [tool];
  const registry = {
    register: () => {}, unregister: () => {},
    resolve: (n: string) => tools.find(t => t.name === n) ?? null,
    list: () => tools, has: (n: string) => tools.some(t => t.name === n),
  } as unknown as ToolRegistry;

  let round = 0;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const r = round++;
      return (async function* () {
        if (r === 0) yield { type: 'tool-call', id: 'c0', name: tool.name, input: {} };
        else         yield { type: 'text-delta', delta: 'the answer' };
        yield { type: 'done' };
      })();
    },
  };
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const run = createSessionRunner({
    store, resolveProvider: async () => ({ adapter, config }), tools: registry,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  const web = createWebServer({
    store, run, notifier: createNotifier(), tools: registry, heartbeatMs: 60,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  return { session, store, web };
}

/** One browser's persistent per-session stream, recording the event names it receives. */
function attach(base: string, sid: string) {
  const ac = new AbortController();
  const seen: string[] = [];
  const frames: string[] = [];
  const ready = (async () => {
    const res = await fetch(`${base}/events/sessions/${sid}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    void (async () => {
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            frames.push(frame);
            const name = /^event: (.*)$/m.exec(frame)?.[1];
            if (name !== undefined) seen.push(name);
          }
        }
      } catch { /* aborted */ }
    })();
  })();
  return { ac, seen, frames, ready };
}

const settle = (ms = 400): Promise<void> => new Promise(r => setTimeout(r, ms));

async function serve(tool: Tool) {
  const b = boot(tool);
  await new Promise<void>(r => b.web.server.listen(0, '127.0.0.1', r));
  const port = (b.web.server.address() as { port: number }).port;
  return { ...b, base: `http://127.0.0.1:${port}` };
}

const submit = (base: string, sid: string): Promise<Response> =>
  fetch(`${base}/sessions/${sid}/submit`, {
    method: 'POST',
    body: JSON.stringify({ content: 'go', provider: 'fake', concatQueue: true, mode: 'auto' }),
  });

test('a prompt raised with no stream attached is delivered to the next one', { timeout: 20000 }, async () => {
  prompted.length = 0;
  const { session, base, web } = await serve(confirmTool);
  try {
    // Nobody is looking at this conversation when the tool asks.
    assert.equal((await submit(base, session.id)).status, 200);
    await settle();
    assert.deepEqual(prompted, [], 'nothing may answer on the user\'s behalf');

    // The user opens the conversation. The outstanding question is put to them.
    const tab = attach(base, session.id);
    await tab.ready;
    await settle();
    assert.ok(tab.seen.includes('prompt'), `expected the parked prompt; saw ${tab.seen.join(', ')}`);
    assert.match(tab.frames.find(f => f.startsWith('event: prompt'))!, /Install plugin/);

    await fetch(`${base}/sessions/${session.id}/prompt`, { method: 'POST', body: JSON.stringify({ answer: 'yes' }) });
    await settle();
    assert.deepEqual(prompted, ['yes']);
    tab.ac.abort();
  } finally { await web.close(); }
});

test('a reload while a prompt is parked re-delivers it, and answers nothing itself', { timeout: 20000 }, async () => {
  prompted.length = 0;
  const { session, base, web } = await serve(confirmTool);
  try {
    // Two connections, so the server still counts the session as viewed after one goes: a second tab,
    // or the dead socket that made this unrecoverable in the first place.
    const zombie = attach(base, session.id);
    const tab    = attach(base, session.id);
    await zombie.ready; await tab.ready;

    await submit(base, session.id);
    await settle();
    assert.ok(tab.seen.includes('prompt'));

    tab.ac.abort();                       // the tab reloads
    await settle(200);
    assert.deepEqual(prompted, [], 'a viewer going away is not a decision');

    const reloaded = attach(base, session.id);
    await reloaded.ready;
    await settle();
    assert.ok(reloaded.seen.includes('prompt'), `reloaded tab must see the question; saw ${reloaded.seen.join(', ')}`);

    await fetch(`${base}/sessions/${session.id}/prompt`, { method: 'POST', body: JSON.stringify({ answer: 'yes' }) });
    await settle();
    assert.deepEqual(prompted, ['yes']);
    reloaded.ac.abort(); zombie.ac.abort();
  } finally { await web.close(); }
});

test('abandoning a session cancels its prompt rather than answering it', { timeout: 20000 }, async () => {
  prompted.length = 0;
  const { session, store, base, web } = await serve(confirmTool);
  try {
    const tab = attach(base, session.id);
    await tab.ready;
    await submit(base, session.id);
    await settle();
    assert.ok(tab.seen.includes('prompt'));

    // Giving up is the one thing the user unambiguously did.
    await fetch(`${base}/sessions/${session.id}/abort`, { method: 'POST' });
    await settle();
    assert.deepEqual(prompted, [], 'a cancel is not an answer');
    const saved = await store.get(session.id);
    const results = saved!.messages.flatMap(m => m.content.filter(c => c.type === 'tool-result'));
    assert.ok(results.length > 0, 'the tool call is closed out');
    assert.ok(results.every(r => r.isError), 'as an error, not as though the default had been chosen');
    assert.doesNotMatch(JSON.stringify(results), /installed/, 'and the install did not happen');
    tab.ac.abort();
  } finally { await web.close(); }
});

test('the per-session stream heartbeats, so a dead socket is detectable', { timeout: 20000 }, async () => {
  const { session, base, web } = await serve(slowTool);
  try {
    const tab = attach(base, session.id);
    await tab.ready;
    await submit(base, session.id);
    await settle();
    // The comment written at open must not be the only traffic. Without a periodic one, neither end can
    // tell a quiet stream from a dead one: the server goes on reporting successful writes into a zombie
    // (which is how a prompt is lost), and the client's `reader.read()` stays pending, so its reconnect
    // loop never runs. This turn is parked in a tool, so a beat here is a beat with nothing else to send.
    const beats = () => tab.frames.filter(f => f.startsWith(': hb')).length;
    assert.ok(beats() >= 2, `expected keep-alive traffic on an idle stream, got ${beats()} beat(s)`);
    // The global stream carries session-busy and every notification; a zombie there freezes every panel.
    const globalTab = await fetch(`${base}/events`);
    const reader = globalTab.body!.getReader();
    const dec = new TextDecoder();
    let globalBuf = '';
    const readUntilBeat = async () => {
      for (let i = 0; i < 40; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        globalBuf += dec.decode(value, { stream: true });
        if (globalBuf.split(': hb').length - 1 >= 2) return true;
      }
      return false;
    };
    assert.ok(await readUntilBeat(), 'GET /events must heartbeat too');
    await reader.cancel().catch(() => {});
    releaseTool();
    await settle();
    tab.ac.abort();
  } finally { await web.close(); }
});
