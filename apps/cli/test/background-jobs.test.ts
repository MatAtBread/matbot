import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAs, installPrincipalCarrier, ItemChangeKind, RegistryChangeKind } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { AppendMessage, MatbotMachine, Session, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { connectToParent, relayable, serveJob, type Endpoint } from '../../../plugins/background-jobs-node/src/channel.ts';
import { plugin as jobsPlugin, superviseChild } from '../../../plugins/background-jobs-node/src/index.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());

// `matbot-background-jobs-node` runs a job in its own process, which shares this one's storage but none of
// its turns — so the job never writes a session itself. It asks, over an IPC channel, and what it writes
// elsewhere (a file) is announced back over the same channel. These pin the protocol on the real channel,
// what may cross it, and the move from the plugin it replaces.

const PRINCIPAL = { id: 'tester', type: 'user' as const };

test('a job reaches its parent over the real IPC channel, and exits by itself', { timeout: 20000 }, async () => {
  const register = pathToFileURL(join(import.meta.dirname, '..', 'register.js')).href;
  const child = spawn(process.execPath, ['--import', register, join(import.meta.dirname, 'fixtures', 'jobs-child.ts')], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const appended: AppendMessage[][] = [];
  const notified: unknown[] = [];
  serveJob(child as unknown as Endpoint, {
    info:   async () => ({ id: 'job-1', session: 's1', sessionTitle: 'Chat' }),
    append: async (sessionId, messages) => { appended.push(messages); return { sessionId: sessionId ?? 's1', messageIds: ['m1'] }; },
    notify: n => { notified.push(n); },
  });
  // What the plugin does: the channel must not hold this end open either, and delivery must survive it.
  child.channel?.unref();
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => { out += c; });
  const code = await new Promise<number | null>(r => child.once('close', c => r(c)));

  assert.equal(code, 0, 'the job exited on its own — an unreleased channel would have kept it alive');
  const result = JSON.parse(out) as { job: { id: string }; sent: unknown; refused: string };
  assert.equal(result.job.id, 'job-1');
  assert.deepEqual(result.sent, { sessionId: 's1', messageIds: ['m1'] });
  assert.deepEqual(appended, [[{ role: 'assistant', content: [{ type: 'text', text: 'hello from job-1', origin: 'robo' }] }]],
    'what arrives is assistant text the parent can trust the shape of');
  assert.match(result.refused, /only assistant messages/, 'a job cannot speak as the user');
  assert.equal(notified.length, 1, 'a posted announcement was flushed before the job exited');
});

test('a request still waiting when the parent goes away fails rather than hanging', async () => {
  const silent: Endpoint = { send: (_m, cb) => { cb(null); }, on: () => undefined };
  const link = connectToParent(silent);
  const waiting = link.request({ op: 'job' });
  link.close('The process that started this job has gone.');
  await assert.rejects(waiting, /has gone/);
});

test('only an ItemChange crosses from a job, stamped with the job', () => {
  const change = {
    kind: ItemChangeKind, plugin: 'workspace', source: 'workspace', namespace: 'files', id: 'f1',
    operation: 'saved', principal: { id: 'matt', type: 'user' },
  };
  assert.deepEqual(relayable(change, 'job:1'), { ...change, instance: 'job:1' });
  assert.equal(
    relayable({ kind: RegistryChangeKind, plugin: 'core', source: 'tools', registry: 'tools', name: 'bash', operation: 'added' }, 'job:1'),
    undefined, 'a registry change describes the job\'s process — relayed, every spawn would rebuild the parent\'s tool index');
  assert.equal(relayable({ ...change, instance: 'elsewhere' }, 'job:1'), undefined, 'one already relayed is not passed on again');
  assert.equal(relayable({ ...change, operation: 'exploded' }, 'job:1'), undefined, 'a malformed one is dropped, not repaired');
  assert.equal(relayable({ kind: '@fnarr/jobs#JobProgress', plugin: 'x', source: 'x' }, 'job:1'), undefined, 'an unknown kind stays in the job');
});

function memStore<T extends { id: string; version: string }>(seed: T[] = []): { store: Store<T>; docs: Map<string, T> } {
  const docs = new Map<string, T>(seed.map(d => [d.id, d]));
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: T) { docs.set(id, v); },
    async cas(id: string, _e: string, next: T) { docs.set(id, next); return { ok: true as const, doc: next }; },
    async delete(id: string) { return docs.delete(id); },
    async query(q: unknown) { return executeQuery([...docs.values()], q as never); },
  } as unknown as Store<T>;
  return { store, docs };
}

test('it reports to the conversation it was made from, and lists the old plugin\'s schedules to be moved', { timeout: 20000 }, async () => {
  const hourFromNow = new Date(Date.now() + 3_600_000).toISOString();
  const jobs    = memStore<{ id: string; version: string; session?: string }>();
  const legacy  = memStore([{ id: 'old1', version: 'v1', prompt: 'Summarise the news', nextRun: hourFromNow, intervalMs: 86_400_000, output: 'news.md' }]);
  const chat    = { id: 's1', version: 'v1', status: 'active', messages: [], createdAt: '', updatedAt: '' } as unknown as Session;
  const sessions = memStore<Session>([chat]);

  const tools = new Map<string, Tool>();
  const services = {
    configPath:  '/nowhere/matbot.yaml',
    isSubAgent:  () => false,
    sessions:    sessions.store,
    createStore: (ns: string) => (ns === 'schedules' ? legacy.store : jobs.store),
    tools:       { register: (t: Tool) => { tools.set(t.name, t); } },
    Notifier:    { notify: () => {}, consume: () => {} },
  } as unknown as MatbotMachine;

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try { await jobsPlugin.setup!(services); } finally { console.warn = warn; }
  for (const t of jobsPlugin.tools ?? []) tools.set(t.name, t as Tool);

  try {
    assert.ok(warnings.some(w => w.includes('1 schedule(s) left by @matatbread/matbot-tool-background')), warnings.join('\n'));

    const call = (name: string, input: unknown, sessionId = 's1') => runAs(PRINCIPAL, async () => {
      const ctx = { session: { id: sessionId, messages: [] }, signal: new AbortController().signal, provider: 'p' } as unknown as ToolContext;
      const events: Array<{ type: string; value?: unknown; message?: string }> = [];
      for await (const ev of tools.get(name)!.executor.execute(input, ctx)) events.push(ev as never);
      return events;
    });
    const value = (events: Array<{ type: string; value?: unknown; message?: string }>) => {
      const r = events.find(e => e.type === 'result');
      assert.ok(r, JSON.stringify(events));
      return r.value as Record<string, unknown>;
    };

    // The default destination is this conversation, resolved and stored at creation.
    const made = value(await call('background_job', { prompt: 'Remind the user to stretch.', at: '2h' }));
    assert.equal(made['session'], 's1');
    assert.equal(jobs.docs.get(made['id'] as string)?.session, 's1');

    // A call over HTTP carries a stand-in session: no destination, rather than one that does not exist.
    const fromHttp = value(await call('background_job', { prompt: 'p', at: '2h' }, 'stand-in'));
    assert.equal(fromHttp['session'], undefined);

    const named = await call('background_job', { prompt: 'p', at: '2h', session: 'nope' });
    assert.match(named.find(e => e.type === 'error')?.message ?? '', /Session "nope" not found/);

    // The old plugin's schedule is listed, marked, never run — and can be moved: create, then cancel.
    const listed = value(await call('background_job_action', { action: 'list' })) as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(listed.find(r => r['id'] === 'old1'),
      { id: 'old1', version: 'v1', prompt: 'Summarise the news', nextRun: hourFromNow, intervalMs: 86_400_000, output: 'news.md', legacy: true });

    const suspend = await call('background_job_action', { action: 'suspend', id: 'old1' });
    assert.match(suspend.find(e => e.type === 'error')?.message ?? '', /legacy schedule/);

    assert.deepEqual(value(await call('background_job_action', { action: 'cancel', id: 'old1' })), { cancelled: true, id: 'old1', legacy: true });
    assert.equal(legacy.docs.has('old1'), false);
  } finally {
    await jobsPlugin.teardown?.();
  }
});

// A job process that could not be spawned reported it only as `error` on the child. Nothing listened, so
// the event threw in the parent and took the server down, and the run waited on an `exit` that need not
// come. The stdin write to the dead process fails too (EPIPE), equally fatal unheard.
test('a job process that cannot be spawned is reported, not fatal', { timeout: 10000 }, async () => {
  const child = spawn(join(import.meta.dirname, 'no-such-executable'), [], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
  const failed = await superviseChild(child, 'prompt: |\n  hello\n');
  assert.ok(failed instanceof Error && /ENOENT/.test(failed.message), `reported as the spawn failure (${failed?.message})`);
  // A tick for any stray stream error to surface: unheard, it would fail this test as an uncaught exception.
  await new Promise(r => setTimeout(r, 50));
});

test('a job process that runs is supervised to its exit', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'inherit'] });
  assert.equal(await superviseChild(child, 'config'), undefined);
});
