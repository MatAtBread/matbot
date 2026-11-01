import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permitted } from '@matatbread/matbot-core';
import { createVmFunctionRunner, createModuleWrapperRegistry } from '@matatbread/matbot-function-runner-node';
import type { ImportCaller } from '@matatbread/matbot-core';

// The ImportedModuleWrapper seam: function-runner-node owns a registry of per-module wrappers and
// applies them at `import`, before a body sees a granted module. Policy is the registrant's; an
// unwrapped specifier passes through raw.

const caller: ImportCaller = {
  fn: 'probe@0', who: 'function "probe"',
  gate: async () => permitted('user'),
  snapshot: async () => () => permitted('configuration'),
};

test('the registry composes wrappers in order and canonicalises keys both ways', async () => {
  const canonical = (s: string): string => s.includes(':') ? s : `node:${s}`;
  const reg = createModuleWrapperRegistry(canonical);

  const seen: string[] = [];
  const callers: ImportCaller[] = [];
  reg.service('node:os', (m, ctx) => { seen.push(ctx.specifier); callers.push(ctx.caller); return { ...(m as object), order: ['a'] } as never; });
  // Registered under the bare spelling; must meet the same module as 'node:os'. Async wrapper is allowed.
  const handle = reg.service('os', async (m) => { (m as { order: string[] }).order.push('b'); return m; });

  const out = await reg.apply('os', {}, caller) as { order: string[] };
  assert.deepEqual(out.order, ['a', 'b'], 'both wrappers applied, in registration order, async awaited');
  assert.deepEqual(seen, ['node:os'], 'ctx.specifier is the canonical form');
  assert.equal(callers[0], caller, 'ctx.caller is the importing invocation, as handed in');

  handle.remove();
  assert.deepEqual((await reg.apply('node:os', {}, caller) as { order?: string[] }).order, ['a'], 'remove() drops exactly one');

  const passthrough = { y: 1 };
  assert.equal(await reg.apply('node:net', passthrough, caller), passthrough, 'an unwrapped specifier is handed through unchanged');
});

test('the runner applies a registered wrapper to a granted module before returning it', async () => {
  const reg = createModuleWrapperRegistry(s => s);
  const runner = createVmFunctionRunner(2000, { wrapModule: reg.apply });

  reg.service('node:os', (os, ctx) => new Proxy(os as object, {
    get: (target, prop) => prop === 'hostname' ? () => `WRAPPED for ${ctx.caller.fn}` : (target as Record<PropertyKey, unknown>)[prop],
  }) as never);

  const os = await runner.import!('node:os', caller) as typeof import('node:os');
  assert.equal(os.hostname(), 'WRAPPED for probe@0', 'the body receives the mediated module, wrapped for its caller');

  // A module with no wrapper is unchanged.
  const path = await runner.import!('node:path', caller) as typeof import('node:path');
  assert.equal(path.basename('/a/b.txt'), 'b.txt');
});
