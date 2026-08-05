import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// `ToolContract`'s two parameters ride on phantom fields, and the whole tool-typing scheme rests on them:
// ToolProxy turns each arm into a call-signature overload, so `await tool.x(params)` narrows its result by
// the params, and generated code is graded against exactly that. The fields are keyed by non-exported
// `unique symbol`s so the type is uninhabitable — nobody can construct a ToolContract to smuggle a shape
// past the checker.
//
// The failure mode that would make this change invisible is the one the checker's own comments warn about:
// if the ambient types fail to resolve, everything collapses to `any` and bad snippets pass silently. So
// this asserts BOTH directions — a correct use is clean, and a wrong one is still rejected.
const root = join(import.meta.dirname, '..', '..', '..');

const PREFIX = `
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    'probe_tool':
      | import('@matatbread/matbot-plugin-api').ToolContract<{ kind: 'a'; count: number }, { action: 'geta' }>
      | import('@matatbread/matbot-plugin-api').ToolContract<{ kind: 'b'; label: string }, { action: 'getb' }>;
  }
}
declare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;
`;

async function check(snippet: string): Promise<string[]> {
  const source = `${PREFIX}${snippet}\nexport {};\n`;
  return checkSnippetAgainst({
    root,
    source,
    prefixLen:   PREFIX.length,
    prefixLines: PREFIX.split('\n').length - 1,
    apiIndexPath: join(root, 'plugin-api', 'src', 'index.ts'),
  });
}

test('a params-matched arm narrows to that arm\'s result', async () => {
  const diags = await check(`
    async function f(): Promise<number> {
      const r = await tool.probe_tool({ action: 'geta' });
      return r.count;
    }
    void f;
  `);
  assert.deepEqual(diags, [], 'reading the matched arm must type-check');
});

test('reading the WRONG arm is still a type error (the types did not collapse to any)', async () => {
  const diags = await check(`
    async function f(): Promise<string> {
      const r = await tool.probe_tool({ action: 'geta' });
      return r.label;
    }
    void f;
  `);
  assert.ok(diags.length > 0, 'params-based narrowing must reject the other arm');
  assert.ok(diags.some(d => /label/.test(d)), `expected a diagnostic naming 'label', got: ${diags.join('\n')}`);
});

test('an unregistered tool name is a type error', async () => {
  const diags = await check(`
    async function f(): Promise<unknown> { return await tool.no_such_tool({}); }
    void f;
  `);
  assert.ok(diags.length > 0, 'a name absent from ToolContracts must not be callable');
});
