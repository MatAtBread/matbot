import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts, checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// A `ToolContracts`/`MatbotServices` key is registered by declaration MERGING, so a tool with two
// implementations (`plugin` and `provider` each have a node and a browser one) cannot have each
// implementation describe itself: the moment the shapes differ it is a TS2717, and `buildMatbotToolsDts`
// reads the checker rather than the Program's diagnostics, so nothing surfaced it. One declaration won on
// Program file order and its shape was emitted as the contract for whichever implementation was loaded.
//
// This asserts the two halves that made it harmful rather than merely untidy:
//   1. the scan reports a clash instead of silently choosing (the guard for the NEXT one);
//   2. the emitted contract matches what the NODE implementations actually return — the failure was not
//      "no types" but "confidently wrong types", which is worse: the check loop rejected the correct
//      field and accepted one that reads `undefined` at runtime.
const root = join(import.meta.dirname, '..', '..', '..');

test('no ToolContracts/MatbotServices key is declared twice with different types', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built, 'expected the monorepo scan to produce a dts');

  // No exceptions: a key declared twice with different types is always a bug, because "which one wins"
  // is Program file order. Two implementations of one tool share a named contract from plugin-api; a
  // consumer of another package's service imports that package's type rather than restating a slice of
  // it. Both leave exactly one declaration, so this list stays empty.
  assert.deepEqual(
    built.conflicts, [],
    `duplicate contract declaration(s):\n${built.conflicts
      .map(c => `  ${c.registry}.${c.key}: "${c.winner}" wins over ${c.losers.join(', ')}`)
      .join('\n')}`,
  );
});

test('the emitted contract describes what the node tools return, not the browser ones', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built);
  const prefix = `${built.dts}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`;

  const check = async (snippet: string): Promise<string[]> =>
    checkSnippetAgainst({
      root,
      source:      `${prefix}${snippet}\nexport {};\n`,
      prefixLen:   prefix.length,
      prefixLines: prefix.split('\n').length - 1,
      apiIndexPath: join(root, 'plugin-api', 'src', 'index.ts'),
    });

  const list = (expr: string): string =>
    `async function f() { const r = await tool.provider({ action: 'list' }); return r.providers[0]!.${expr}; }`;

  assert.deepEqual(await check(list('hasCredentials')), [], 'the field the node tool yields must typecheck');
  assert.notDeepEqual(await check(list('hasKey')), [], 'the browser-only field must NOT typecheck');

  // The same divergence on the params side: node takes `module`, the browser tool used to take `adapter`.
  assert.deepEqual(
    await check(`async function f() { return tool.provider({ action: 'add', name: 'n', module: 'm', model: 'z' }); }`),
    [],
  );

  // A named result shape stays CLOSED — augmentable is not the same as loose.
  assert.notDeepEqual(
    await check(`async function f() { const r = await tool.plugin({ action: 'list' }); return r.loaded[0]!.nope; }`),
    [],
  );
});
