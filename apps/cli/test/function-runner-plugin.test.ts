import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import { plugin, FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';
import type { FunctionRunner, MatbotMachine } from '@matatbread/matbot-plugin-api';

// The node runner is a PLUGIN, not part of the host: bounding a body, withholding host globals from it
// and gating its imports are all optional, and reachable through the `FunctionRunner` seam alone. These
// pin the two things that moving it out of the host actually changed.

interface Setup { registered: Record<string, unknown>; warnings: string[] }

async function setupWith(stored: Record<string, unknown>, configPath?: string): Promise<Setup> {
  const registered: Record<string, unknown> = {};
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    await plugin.setup!({
      settings: () => ({ get: (k: string) => Promise.resolve(stored[k]) }),
      register: (k: string, v: unknown) => { registered[k] = v; return Promise.resolve(); },
      ...(configPath !== undefined ? { configPath } : {}),
    } as unknown as MatbotMachine);
  } finally { console.warn = warn; }
  return { registered, warnings };
}

test('the plugin registers a runner built from its own settings', async () => {
  // Its settings, not the host's config: `function_timeout_ms` and `function_imports` were read by
  // apps/cli, which is exactly the coupling moving this out removes.
  const { registered } = await setupWith({ permit_imports: ['node:os'] }, '/tmp/proj/matbot.yaml');
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.ok(runner !== undefined, 'registered under the service key, like any other plugin');
  assert.deepEqual([...runner.permittedImports ?? []], ['node:os']);
  assert.ok((runner.withheldGlobals ?? []).includes('process'), 'and it publishes what it withholds');

  // Absent settings are the defaults, and `permittedImports` must stay ABSENT rather than becoming []:
  // an empty list is the configured "never", while no key at all means unrestricted-and-ask.
  const bare = (await setupWith({})).registered['FunctionRunner'] as FunctionRunner;
  assert.equal(bare.permittedImports, undefined, 'no restriction configured ⇒ none claimed');
});

test('timeout_ms: 0 is warned about, and removes the TIME bound only', async () => {
  const { registered, warnings } = await setupWith({ timeout_ms: 0 });
  assert.match(warnings.join('\n'), /run unbounded/);
  assert.match(warnings.join('\n'), /withheld globals and the import gate are unaffected/);
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.ok((runner.withheldGlobals ?? []).includes('eval'), 'still withheld');
  // And the bound really is off: this would be stopped under any positive limit.
  const slow = runner.compile(`(async function () { const u = Date.now() + 250; while (Date.now() < u) {} return 'done'; })`);
  assert.equal(await slow(() => Promise.reject(new Error('no loader'))), 'done');
  assert.ok(FUNCTION_SYNC_LIMIT_MS > 0, 'while the default is a real bound');
});

test('the declarations follow the runner with nothing to invalidate', async () => {
  // The obvious thing to reach for, now that the runner is a plugin that can arrive after a dts has been
  // handed out, is a subscription that rebuilds on a `services` registry change. It would be dead weight:
  // nothing derived from the runner is held. The note is composed on every call, `check` passes the two
  // lists fresh to each run, and the one cache over them keys on the permit array by identity. What IS
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

  runner = createVmFunctionRunner(0, { permit: ['node:os'] });
  const after = await index.dts();
  assert.match(after, /Absent: process[^\n]*\beval\b/, 'the withheld list is there, with no event fired');
  assert.match(after, /node:os/, 'and so is the permitted set');
  index.close();
});

test('the declarations do not promise a prompt that nothing will raise', async () => {
  // Whether an import is GATED is whether a runner routes it, not whether a restriction exists. With no
  // runner nothing rewrites `import(…)` — it reaches node's own loader, unasked — so a body told "you
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
