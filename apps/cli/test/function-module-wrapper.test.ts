import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVmFunctionRunner, createModuleWrapperRegistry } from '@matatbread/matbot-function-runner-node';

// The ImportedModuleWrapper seam: function-runner-node owns a registry of per-module wrappers and
// applies them at `import`, before a body sees a granted module. Policy is the registrant's; an
// unwrapped specifier passes through raw.

test('the registry composes wrappers in order and canonicalises keys both ways', async () => {
  const canonical = (s: string): string => s.includes(':') ? s : `node:${s}`;
  const reg = createModuleWrapperRegistry(canonical);

  const seen: string[] = [];
  reg.service('node:os', (m, ctx) => { seen.push(ctx.specifier); return { ...(m as object), order: ['a'] } as never; });
  // Registered under the bare spelling; must meet the same module as 'node:os'. Async wrapper is allowed.
  const handle = reg.service('os', async (m) => { (m as { order: string[] }).order.push('b'); return m; });

  const out = await reg.apply('os', {}) as { order: string[] };
  assert.deepEqual(out.order, ['a', 'b'], 'both wrappers applied, in registration order, async awaited');
  assert.deepEqual(seen, ['node:os'], 'ctx.specifier is the canonical form');

  handle.remove();
  assert.deepEqual((await reg.apply('node:os', {}) as { order?: string[] }).order, ['a'], 'remove() drops exactly one');

  const passthrough = { y: 1 };
  assert.equal(await reg.apply('node:net', passthrough), passthrough, 'an unwrapped specifier is handed through unchanged');
});

test('the runner applies a registered wrapper to a granted module before returning it', async () => {
  const reg = createModuleWrapperRegistry(s => s);
  const runner = createVmFunctionRunner(2000, { wrapModule: reg.apply });

  reg.service('node:os', os => new Proxy(os as object, {
    get: (target, prop) => prop === 'hostname' ? () => 'WRAPPED' : (target as Record<PropertyKey, unknown>)[prop],
  }) as never);

  const os = await runner.import!('node:os') as typeof import('node:os');
  assert.equal(os.hostname(), 'WRAPPED', 'the body receives the mediated module');

  // A module with no wrapper is unchanged.
  const path = await runner.import!('node:path') as typeof import('node:path');
  assert.equal(path.basename('/a/b.txt'), 'b.txt');
});
