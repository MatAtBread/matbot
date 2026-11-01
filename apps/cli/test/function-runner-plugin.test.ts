import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import { plugin, FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';
import type {
  FunctionRunner, MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent,
} from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';

// The node runner is a PLUGIN, not part of the host: bounding a body, withholding host globals from it
// and gating its imports are all optional, and reachable through the `FunctionRunner` seam alone. These
// pin the two things that moving it out of the host actually changed.

const timeoutOf = async (r: FunctionRunner): Promise<number | undefined> =>
  ((await r.settings?.()) as { timeoutMs?: number } | undefined)?.timeoutMs;

interface Setup {
  registered: Record<string, unknown>;
  tools:      Map<string, Tool>;
  warnings:   string[];
  /** The per-principal override layer the tool writes, above the install's `floor`. */
  stored:     Record<string, unknown>;
  asked:      PermissionRequest[];
  /** Run the config tool and return its one event. */
  call:       (input: unknown, allow?: boolean) => Promise<ToolEvent>;
}

async function setupWith(
  floor: Record<string, unknown>,
  opts: { projectDir?: string; stored?: Record<string, unknown> } = {},
): Promise<Setup> {
  const registered: Record<string, unknown> = {};
  const tools = new Map<string, Tool>();
  const warnings: string[] = [];
  const stored: Record<string, unknown> = { ...opts.stored };
  const asked: PermissionRequest[] = [];
  // Settings as the host layers them: the stored key if present (`in`, so a stored null is an override),
  // else the installation's `default_settings:` floor. A write touches only the override.
  const settings = {
    get: (k: string) => Promise.resolve(k in stored ? stored[k] : floor[k]),
    set: (k: string, v: unknown) => { stored[k] = v; return Promise.resolve(); },
    delete: (k: string) => { delete stored[k]; return Promise.resolve(); },
  };
  const warn = console.warn;
  const capturing = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { return await fn(); } finally { console.warn = prev; }
  };
  // The runner reads — and so warns — per invocation, long after setup has returned.
  const capturedRunner = (r: FunctionRunner): FunctionRunner => r.settings === undefined ? r
    : Object.assign(Object.create(r) as FunctionRunner, { settings: () => capturing(() => r.settings!()) });
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    await plugin.setup!({
      settings: () => settings,
      register: (k: string, v: unknown) => {
        registered[k] = k === 'FunctionRunner' ? capturedRunner(v as FunctionRunner) : v;
        return Promise.resolve();
      },
      tools: { register: (t: Tool) => { tools.set(t.name, t); } },
      get FunctionRunner() { return registered['FunctionRunner'] as FunctionRunner | undefined; },
      ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
    } as unknown as MatbotMachine);
  } finally { console.warn = warn; }

  const call = async (input: unknown, allow = true): Promise<ToolEvent> => {
    const ctx = {
      callId: 'c', session: { id: 's' }, signal: new AbortController().signal,
      gate: (req: PermissionRequest) => { asked.push(req); return Promise.resolve(allow ? permitted('user') : refused('user')); },
    } as unknown as ToolContext;
    let last: ToolEvent | undefined;
    for await (const ev of tools.get('function_runner_config')!.executor.execute(input, ctx)) last = ev;
    return last!;
  };
  return { registered, tools, warnings, stored, asked, call };
}

test('the plugin registers a runner built from its own settings', async () => {
  // Its settings, not the host's config: `function_timeout_ms` and `function_imports` were read by
  // apps/cli, which is exactly the coupling moving this out removes.
  const { registered } = await setupWith({ timeout_ms: 500 }, { projectDir: '/tmp/proj' });
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.ok(runner !== undefined, 'registered under the service key, like any other plugin');
  assert.equal(await timeoutOf(runner), 500);
  assert.ok((runner.withheldGlobals ?? []).includes('process'), 'and it publishes what it withholds');

  const bare = (await setupWith({})).registered['FunctionRunner'] as FunctionRunner;
  assert.equal(await timeoutOf(bare), FUNCTION_SYNC_LIMIT_MS);
  // What a body may import is not the runner's to say: nothing about it rides on the settings.
  assert.deepEqual(Object.keys(await bare.settings!()), ['timeoutMs']);
});

test('the retired permit_imports is not read, and says so rather than silently widening', async () => {
  // An installation that authored it had imports refused outside its list. Unread, every import is now
  // asked about — a widening nobody chose — so it warns, names the replacement, and `get` reports it.
  const s = await setupWith({ permit_imports: ['node:os'] });
  await (s.registered['FunctionRunner'] as FunctionRunner).settings!();
  assert.match(s.warnings.join('\n'), /permit_imports is no longer read/);
  assert.match(s.warnings.join('\n'), /deny:tool_function\.import/);
  const got = await call_ok(await s.call({ action: 'get' }));
  assert.equal(got.problems?.length, 1);
  assert.equal('permitImports' in got, false);

  // A stored override is otherwise unremovable through any tool, so `clear` forgets it.
  const stored = await setupWith({}, { stored: { permit_imports: [] } });
  await call_ok(await stored.call({ action: 'clear' }));
  assert.equal('permit_imports' in stored.stored, false);
});

test('timeout_ms: 0 is warned about, and removes the TIME bound only', async () => {
  const { registered, warnings } = await setupWith({ timeout_ms: 0 });
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.deepEqual(warnings, [], 'setup reads nothing: whose settings they are is not known until an invocation');
  const settings = await runner.settings!();
  await runner.settings!();
  assert.match(warnings.join('\n'), /run unbounded/);
  assert.match(warnings.join('\n'), /withheld globals and the import gate are unaffected/);
  assert.equal(warnings.length, 1, 'warned once, not on every read');
  assert.ok((runner.withheldGlobals ?? []).includes('eval'), 'still withheld');
  // And the bound really is off: this would be stopped under any positive limit.
  const slow = runner.compile(`(async function () { const u = Date.now() + 250; while (Date.now() < u) {} return 'done'; })`);
  assert.equal(await slow({ importModule: () => Promise.reject(new Error('no loader')), settings }), 'done');
  assert.ok(FUNCTION_SYNC_LIMIT_MS > 0, 'while the default is a real bound');
});

test('the declarations follow the runner with nothing to invalidate', async () => {
  // The obvious thing to reach for, now that the runner is a plugin that can arrive after a dts has been
  // handed out, is a subscription that rebuilds on a `services` registry change. It would be dead weight:
  // nothing derived from the runner is held. The note is composed on every call, and `check` passes the
  // withheld list fresh to each run. What IS
  // cached is the source scan, which the runner has no part in — so subscribing would discard a good
  // TypeScript build to recompute something that was never stale.
  //
  // Asserted by building a dts BEFORE the runner exists and reading it again after, with no event fired.
  let runner: FunctionRunner | undefined;
  const machine = {
    tools: { list: () => [], resolve: () => null },
    Notifier: { consume: () => {} },
    get FunctionRunner() { return runner; },
  } as unknown as MatbotMachine;

  const index = new ToolTypeIndexImpl(machine, () => Promise.resolve(null));
  const before = await index.dts();
  assert.doesNotMatch(before, /Absent:/, 'no runner ⇒ nothing is claimed about what is out of scope');

  runner = createVmFunctionRunner(0);
  const after = await index.dts();
  assert.match(after, /Absent: process[^\n]*\beval\b/, 'the withheld list is there, with no event fired');
  assert.match(after, /subject to permission at the call/, 'and the import gate it routes to');
  index.close();
});

test('the declarations do not promise a prompt that nothing will raise', async () => {
  // Whether an import is GATED is whether a runner routes it. With no runner nothing rewrites `import(…)` — it reaches node's own loader, unasked — so a body told "you
  // will be asked the first time" discovers the contradiction the first time it imports anything.
  const dtsFor = async (runner: FunctionRunner | undefined): Promise<string> => {
    const index = new ToolTypeIndexImpl({
      tools: { list: () => [], resolve: () => null },
      Notifier: { consume: () => {} },
      FunctionRunner: runner,
    } as unknown as MatbotMachine, () => Promise.resolve(null));
    try { return await index.dts(); } finally { index.close(); }
  };

  const guarded = await dtsFor(createVmFunctionRunner(0));
  assert.match(guarded, /subject to permission at the call/);
  assert.match(guarded, /you will be asked/);

  const bare = await dtsFor(undefined);
  assert.match(bare, /A body may import node builtins/, 'still true: they resolve natively');
  assert.doesNotMatch(bare, /subject to permission/, 'nothing routes the import, so nothing decides it');
  assert.doesNotMatch(bare, /you will be asked/);
});

// ── function_runner_config ─────────────────────────────────────────────────────
// The setting belongs to this plugin, so reading and changing it does too. The host's
// `function_timeout_ms` could never have worked: the default runner has no way to implement it, so the
// host was parsing a question only a plugin can answer.

test('the config tool reports what is in effect, floor included', async () => {
  const floored = await call_ok(await (await setupWith({ timeout_ms: 75 })).call({ action: 'get' }));
  assert.equal(floored.timeoutMs, 75, 'the install floor');
  const { call } = await setupWith({ timeout_ms: 75 }, { stored: { timeout_ms: 50 } });
  const got = await call({ action: 'get' });
  assert.deepEqual(got, { type: 'result', value: {
    timeoutMs: 50, timeoutMsDefault: FUNCTION_SYNC_LIMIT_MS,
    withheldGlobals: [...createVmFunctionRunner(0).withheldGlobals ?? []],
  } }, 'the override above the floor — nothing says which is which');
});

test('a change applies from the next invocation, with nothing rebuilt', async () => {
  // The settings are read per invocation, so the runner registered at setup is the runner for good — and
  // a change written anywhere (this tool, another process, a hand-edited document) is simply read next.
  const s = await setupWith({});
  const runner = s.registered['FunctionRunner'] as FunctionRunner;
  assert.equal(await timeoutOf(runner), FUNCTION_SYNC_LIMIT_MS);

  const set = await call_ok(await s.call({ action: 'set', timeoutMs: 40 }));
  assert.equal(set.timeoutMs, 40);
  assert.equal(s.registered['FunctionRunner'], runner, 'the same runner');
  assert.equal(await timeoutOf(runner), 40);

  s.stored['timeout_ms'] = 25;
  assert.equal(await timeoutOf(runner), 25, 'a write that bypassed the tool too');
});

test('null reverts to the installation default', async () => {
  const s = await setupWith({ timeout_ms: 75 }, { stored: { timeout_ms: 0 } });
  assert.equal(await timeoutOf(s.registered['FunctionRunner'] as FunctionRunner), 0);
  assert.equal((await call_ok(await s.call({ action: 'set', timeoutMs: null }))).timeoutMs, 75);
  assert.equal('timeout_ms' in s.stored, false, 'the override is gone, not overwritten with the floor');
  // With no floor the same revert is the coded default.
  const bare = await setupWith({}, { stored: { timeout_ms: 0 } });
  assert.equal((await call_ok(await bare.call({ action: 'clear' }))).timeoutMs, FUNCTION_SYNC_LIMIT_MS);
});

test('a change is a decision, and a refusal changes nothing', async () => {
  const s = await setupWith({});
  const refused = await s.call({ action: 'set', timeoutMs: 10 }, false);
  assert.equal(refused.type, 'error');
  assert.match(String((refused as { message: string }).message), /timeout_ms. was not changed/);
  assert.equal('timeout_ms' in s.stored, false, 'nothing is written before the gate answers');
  assert.deepEqual(s.asked.map(r => [r.gate, r.subject]), [['set', 'timeout_ms']]);
  // The label is the question, not the key, and names what is in force now.
  assert.match(s.asked[0]!.label, /compute without awaiting\? Currently 10000ms/);
  assert.deepEqual(s.asked[0]!.standing?.map(a => a.subject), ['timeout_ms', '*'], 'narrowest first');

  // A set that asks for nothing, and a bad value, are refused before any gate is raised.
  s.asked.length = 0;
  assert.equal((await s.call({ action: 'set' })).type, 'error');
  assert.equal((await s.call({ action: 'set', timeoutMs: -1 })).type, 'error');
  assert.deepEqual(s.asked, []);
});

function call_ok(ev: ToolEvent): Promise<{ timeoutMs: number; problems?: string[] }> {
  assert.equal(ev.type, 'result', JSON.stringify(ev));
  return Promise.resolve((ev as { value: { timeoutMs: number; problems?: string[] } }).value);
}

test('settings that reach the runner without the tool are checked too', async () => {
  // `default_settings:` and a hand-edited document never pass through `set`. A negative bound used to
  // run bodies unbounded without the timeout_ms: 0 warning.
  const neg = await setupWith({ timeout_ms: -1 });
  await (neg.registered['FunctionRunner'] as FunctionRunner).settings!();
  assert.match(neg.warnings.join('\n'), /timeout_ms must be a non-negative integer/);
  const got = await call_ok(await neg.call({ action: 'get' }));
  assert.equal(got.timeoutMs, FUNCTION_SYNC_LIMIT_MS, 'the coded default, not unbounded');
  assert.equal(got.problems?.length, 1, 'and get says why');
});
