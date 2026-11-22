import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentPrincipal, runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import type { MatbotMachine, MatbotPluginSpec, Principal, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createBackgroundJobsPlugin, plugin as inProcessPlugin, type JobRunner } from '../../../plugins/background-jobs/src/index.ts';
import { plugin as ownProcessPlugin } from '../../../plugins/background-jobs-node/src/index.ts';

// `inFlight` holds every principal's runs and a run-now job has no row, so nothing but an explicit check
// scopes one: `list` showed each user the others' prompts, and `cancel` stopped whichever it was given. The
// scenarios run against both runners, because a job's process is where the two differ and the model is
// promised no difference at all.

installPrincipalCarrier(createAlsPrincipalCarrier());

const ALICE: Principal = { id: 'alice', type: 'user' };
const BOB:   Principal = { id: 'bob',   type: 'user' };

type Event = { type: string; value?: unknown; message?: string };
type Row = { id: string; version: string; [k: string]: unknown };

// Storage partitioned per principal, as a profiles backend gives: each sees only its own rows.
function partitionedStore(): Store<Row> {
  const partitions = new Map<string, Map<string, Row>>();
  const mine = () => {
    const id = currentPrincipal().id;
    if (!partitions.has(id)) partitions.set(id, new Map());
    return partitions.get(id)!;
  };
  return {
    async get(id: string) { return mine().get(id) ?? null; },
    async set(id: string, v: Row) { mine().set(id, v); },
    async cas(id: string, _e: string, next: Row) { mine().set(id, next); return { ok: true as const, doc: next }; },
    async delete(id: string) { return mine().delete(id); },
    async query() { return { items: [...mine().values()] }; },
  } as unknown as Store<Row>;
}

async function until(what: string, holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

async function standUp(plugin: MatbotPluginSpec, store: Store<Row> = partitionedStore(), isSubAgent = false) {
  const services = {
    isSubAgent:  () => isSubAgent,
    createStore: (ns: string) => (ns === 'jobs' ? store : new MemoryStore()),
  } as unknown as MatbotMachine;
  await runAs(ALICE, () => plugin.setup!(services));

  const tools = new Map((plugin.tools ?? []).map((t: Tool) => [t.name, t]));
  const ctx   = { callId: 'c1', signal: new AbortController().signal, provider: 'test-provider' } as unknown as ToolContext;
  const call = (who: Principal, name: string, input: unknown) => runAs(who, async () => {
    const events: Event[] = [];
    for await (const ev of tools.get(name)!.executor.execute(input, ctx)) events.push(ev as never);
    return events;
  });
  const result = async (who: Principal, name: string, input: unknown) => {
    const events = await call(who, name, input);
    const found = events.find(e => e.type === 'result');
    assert.ok(found, `${name} gave no result: ${JSON.stringify(events)}`);
    return found.value as Record<string, unknown>;
  };
  const refusal = async (who: Principal, name: string, input: unknown) => {
    const events = await call(who, name, input);
    assert.equal(events.some(e => e.type === 'result'), false, `${name} should have refused: ${JSON.stringify(events)}`);
    return events.find(e => e.type === 'error')?.message ?? '';
  };
  const list = async (who: Principal) => await result(who, 'background_job_action', { action: 'list' }) as unknown as Array<Record<string, unknown>>;
  return { call, result, refusal, list, done: async () => { await plugin.teardown?.(); } };
}

/** A runner of each kind, with what each scenario needs to see of a run: that it started, and that it stopped. */
interface Flavour {
  plugin:  MatbotPluginSpec;
  setup(): void;
  /** Resolves when the run has really begun, having checked what it was started with. */
  started(prompt: string): Promise<void>;
  alive():  boolean;
  /** Resolves when the run has really ended. */
  stopped(): Promise<void>;
  cleanup(): void;
}

function inProcess(): Flavour {
  const signals: AbortSignal[] = [];
  const runner: JobRunner = {
    run: (_job, signal) => new Promise(resolve => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve({ appended: 0, reply: '' }), { once: true });
    }),
  };
  return {
    plugin: createBackgroundJobsPlugin({ description: 'test', runner: () => runner }),
    setup() {},
    started: () => until('the run has started', () => signals.length > 0),
    alive:   () => signals.at(-1)?.aborted === false,
    stopped: () => until('the run has stopped', () => signals.at(-1)?.aborted === true),
    cleanup() {},
  };
}

// The real runner, a real child process and a real kill. What the child is, is the only thing stood in: a job
// is the CLI's own command line, so the entry script is the one thing here that has to be swapped.
function ownProcess(): Flavour {
  const dir   = mkdtempSync(join(tmpdir(), 'matbot-job-'));
  const probe = join(dir, 'probe.json');
  const read  = () => JSON.parse(readFileSync(probe, 'utf8')) as { pid: number; config: string; isSubAgent?: string; principal?: string };
  const running = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const before = { script: process.argv[1], config: process.env['MATBOT_CONFIG'], file: process.env['JOB_PROBE_FILE'] };
  return {
    plugin: ownProcessPlugin,
    setup() {
      process.argv[1] = join(import.meta.dirname, 'fixtures', 'job-held-open.ts');
      process.env['MATBOT_CONFIG']  = join(dir, 'matbot.yaml');
      process.env['JOB_PROBE_FILE'] = probe;
    },
    async started(prompt) {
      await until('the job process has started', () => existsSync(probe));
      const seen = read();
      assert.match(seen.config, new RegExp(prompt), 'the job was handed its prompt');
      assert.equal(seen.isSubAgent, '1');
      assert.deepEqual(JSON.parse(seen.principal!), ALICE, 'the job runs as its creator');
    },
    alive:   () => existsSync(probe) && running(read().pid),
    stopped: () => until('the job process has exited', () => !running(read().pid)),
    cleanup() {
      process.argv[1] = before.script!;
      if (before.config === undefined) delete process.env['MATBOT_CONFIG']; else process.env['MATBOT_CONFIG'] = before.config;
      if (before.file   === undefined) delete process.env['JOB_PROBE_FILE']; else process.env['JOB_PROBE_FILE'] = before.file;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [name, flavour] of [['in this process', inProcess], ['in its own process', ownProcess]] as const) {
  test(`a run-now job ${name}: its id reaches its owner's list and cancel, and no one else's`, { timeout: 30_000 }, async () => {
    const f = flavour();
    f.setup();
    const m = await standUp(f.plugin);
    try {
      const made = await m.result(ALICE, 'background_job', { prompt: 'PRIVATE-PROMPT', name: 'mine' });
      assert.equal(made['status'], 'started');
      assert.equal(typeof made['id'], 'string', 'the handle is returned, not left to be found by matching the prompt');
      await f.started('PRIVATE-PROMPT');

      const [own, ...others] = await m.list(ALICE);
      assert.deepEqual(others, []);
      assert.equal(own?.['id'], made['id']);
      assert.equal(own?.['inFlight'], true);
      assert.equal(own?.['prompt'], 'PRIVATE-PROMPT');
      assert.equal(own?.['name'], 'mine');
      assert.equal('principal' in own!, false);

      assert.deepEqual(await m.list(BOB), [], 'another principal is not shown it');
      const id = made['id'];
      const refused = await m.refusal(BOB, 'background_job_action', { action: 'cancel', id });
      assert.equal(refused, await m.refusal(BOB, 'background_job_action', { action: 'cancel', id: 'no-such-job' }).then(r => r.replace('no-such-job', String(id))),
        'indistinguishable from an id that does not exist');
      assert.equal(f.alive(), true, 'and it is still running');

      for (const action of ['suspend', 'resume']) {
        assert.match(await m.refusal(ALICE, 'background_job_action', { action, id }), /no stored row.*cancel/, `${action} says what does apply`);
      }
      assert.match(await m.refusal(BOB, 'background_job_action', { action: 'suspend', id }), /not found/);

      assert.deepEqual(await m.result(ALICE, 'background_job_action', { action: 'cancel', id }), { cancelled: true, id });
      await f.stopped();
      assert.deepEqual(await m.list(ALICE), []);
    } finally {
      await m.done();
      f.cleanup();
    }
  });

  test(`a stored job ${name}: flagged beside its row, and invisible across a partition`, { timeout: 30_000 }, async () => {
    const f = flavour();
    f.setup();
    const m = await standUp(f.plugin);
    try {
      const { id } = await m.result(ALICE, 'background_job', { prompt: 'STORED-PROMPT', at: '1ms' });
      await f.started('STORED-PROMPT');
      const [row] = await m.list(ALICE);
      assert.equal(row?.['id'], id);
      assert.equal(row?.['inFlight'], true);
      assert.ok(row?.['nextRun'], 'the row itself, with the flag beside it');

      assert.deepEqual(await m.list(BOB), [], 'its row is not in this partition, and it does not reappear as a bare run');
      assert.match(await m.refusal(BOB, 'background_job_action', { action: 'cancel', id }), /not found/);
      assert.equal(f.alive(), true);

      await m.result(ALICE, 'background_job_action', { action: 'cancel', id });
      await f.stopped();
      assert.deepEqual(await m.list(ALICE), []);
    } finally {
      await m.done();
      f.cleanup();
    }
  });
}

test('the two plugins offer the model the same tools', () => {
  const surface = (p: MatbotPluginSpec) => (p.tools ?? []).map((t: Tool) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  assert.deepEqual(surface(ownProcessPlugin), surface(inProcessPlugin));
  assert.deepEqual(surface(inProcessPlugin).map(t => t.name), ['background_job', 'background_job_action']);
});

// A job's process runs no scheduler and holds no store, under either plugin. What matters is that it says so
// rather than reporting a cancel it did not make.
for (const [name, plugin] of [['background-jobs', inProcessPlugin], ['background-jobs-node', ownProcessPlugin]] as const) {
  test(`${name} in a process that is itself a job has nothing to manage, and says so`, async () => {
    const m = await standUp(plugin, partitionedStore(), true);
    try {
      assert.deepEqual(await m.list(ALICE), []);
      assert.match(await m.refusal(ALICE, 'background_job_action', { action: 'cancel', id: 'x' }), /not found/);
      assert.match(await m.refusal(ALICE, 'background_job', { prompt: 'p' }), /cannot run in this matbot/);
    } finally {
      await m.done();
    }
  });
}

test('a run that ends by itself leaves the list and nothing behind on the plugin\'s signal', async () => {
  let finish = (): void => {};
  const plugin = createBackgroundJobsPlugin({
    description: 'test',
    runner: () => ({ run: () => new Promise(resolve => { finish = () => resolve({ appended: 1, reply: '' }); }) }),
  });
  const Real = globalThis.AbortController;
  const made: AbortController[] = [];
  globalThis.AbortController = class extends Real { constructor() { super(); made.push(this); } };
  const m = await standUp(plugin).finally(() => { globalThis.AbortController = Real; });
  try {
    const signal = made[0]!.signal;
    const idle = getEventListeners(signal, 'abort').length;

    await m.result(ALICE, 'background_job', { prompt: 'p' });
    assert.equal(getEventListeners(signal, 'abort').length, idle + 1);
    assert.equal((await m.list(ALICE)).length, 1);

    finish();
    await until('the run has settled', () => getEventListeners(signal, 'abort').length === idle);
    assert.deepEqual(await m.list(ALICE), []);
  } finally {
    await m.done();
  }
});

test('a cancel the store refuses leaves the run alone', async () => {
  const signals: AbortSignal[] = [];
  const plugin = createBackgroundJobsPlugin({
    description: 'test',
    runner: () => ({
      run: (_job, signal) => new Promise(resolve => {
        signals.push(signal);
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      }),
    }),
  });
  // One row both principals can read and only its owner can write: a read-only share.
  const docs = new Map<string, Row>();
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Row) { docs.set(id, v); },
    async cas(id: string, _e: string, next: Row) { docs.set(id, next); return { ok: true as const, doc: next }; },
    async delete(id: string) {
      if (currentPrincipal().id !== ALICE.id) throw new Error('shared in read-only');
      return docs.delete(id);
    },
    async query() { return { items: [...docs.values()] }; },
  } as unknown as Store<Row>;
  const m = await standUp(plugin, store);
  try {
    const { id } = await m.result(ALICE, 'background_job', { prompt: 'p', at: '1ms' });
    await until('the run has started', () => signals.length > 0);

    assert.equal((await m.list(BOB))[0]?.['inFlight'], true, 'a row the reader can see carries the flag');
    await assert.rejects(m.call(BOB, 'background_job_action', { action: 'cancel', id }), /read-only/);
    assert.equal(signals[0]!.aborted, false);
    assert.equal(docs.has(id as string), true);

    await m.result(ALICE, 'background_job_action', { action: 'cancel', id });
    assert.equal(signals[0]!.aborted, true);
  } finally {
    await m.done();
  }
});
