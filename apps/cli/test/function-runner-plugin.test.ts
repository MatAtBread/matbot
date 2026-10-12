import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { RegistryChangeKind } from '@matatbread/matbot-core';
import { ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import { plugin, FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';
import type { FunctionRunner, MatbotMachine, Notification } from '@matatbread/matbot-plugin-api';

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

test('the tool dts is rebuilt when a FunctionRunner arrives, not just when tools change', async () => {
  // What the type index derives from the runner is CACHED — the permitted set becomes the program's
  // `paths` and IMPORT-GATE's list, the withheld globals become ENV-GATE's, and the note is composed
  // from both. While the runner was seeded by the host that could not go stale; it is a plugin now, so
  // it can arrive after a dts has been built and handed out. The index therefore watches the SERVICES
  // registry for this key as well as the tool registry.
  let sink: ((n: Notification) => void) | undefined;
  let runner: FunctionRunner | undefined;
  const machine = {
    tools: { list: () => [], resolve: () => null },
    Notifier: { consume: (fn: (n: Notification) => void) => { sink = fn; } },
    get FunctionRunner() { return runner; },
  } as unknown as MatbotMachine;

  const index = new ToolTypeIndexImpl(machine, () => Promise.resolve(null));
  const before = await index.dts();
  assert.doesNotMatch(before, /Absent:/, 'no runner ⇒ nothing is claimed about the environment');

  runner = createVmFunctionRunner(0, { permit: ['node:os'] });
  assert.ok(sink !== undefined, 'the index subscribed');
  sink!({ kind: RegistryChangeKind, registry: 'services', name: 'FunctionRunner', operation: 'added' } as unknown as Notification);

  const after = await index.dts();
  assert.match(after, /Absent: process[^\n]*\beval\b/, 'the withheld list reached the note, and so ENV-GATE');
  assert.match(after, /node:os/, 'and the permitted set reached the listing');

  // A change to some OTHER service does not invalidate it — the cache is a TypeScript program, and
  // rebuilding it on every registration would make boot quadratic in the plugins loaded.
  const cached = await index.dts();
  sink!({ kind: RegistryChangeKind, registry: 'services', name: 'MediaStore', operation: 'added' } as unknown as Notification);
  assert.equal(await index.dts(), cached);
  index.close();
});
