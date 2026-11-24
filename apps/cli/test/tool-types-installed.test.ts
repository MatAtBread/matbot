import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { checkSnippetAgainst as CheckSnippetAgainst } from '@matatbread/matbot-tool-types';

// Issue #118: installed from npm, every package lives under node_modules, where node refuses to strip types
// from a file. The checker's worker loads no hooks, so whatever it loads by path must not depend on node's
// stripping — in the monorepo nothing is under node_modules, and the failure was invisible.
test('the checker reports parameter schemas when tool-types is installed under node_modules', { timeout: 60000 }, async t => {
  const src = dirname(fileURLToPath(import.meta.resolve('@matatbread/matbot-tool-types')));
  const require = createRequire(join(src, '_'));
  const root = mkdtempSync(join(tmpdir(), 'mb-tool-types-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const modules = join(root, 'node_modules');
  const pkg = join(modules, '@matatbread', 'matbot-tool-types');
  cpSync(src, join(pkg, 'src'), { recursive: true });
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(modules, 'typescript'), 'dir');
  mkdirSync(join(modules, '@matatbread'), { recursive: true });
  symlinkSync(realpathSync(join(src, '..', 'node_modules', '@matatbread', 'matbot-plugin-api')), join(modules, '@matatbread', 'matbot-plugin-api'), 'dir');

  const { checkSnippetAgainst } = await import(pathToFileURL(join(pkg, 'src', 'checker.ts')).href) as { checkSnippetAgainst: typeof CheckSnippetAgainst };
  const report = await checkSnippetAgainst({
    root, source: 'async function twice(n: number): Promise<number> { return n * 2 }', prefixLen: 0, prefixLines: 0,
    parametersOf: ['twice'],
  });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.deepEqual(report.parameters?.['twice'], [{ name: 'n', optional: false, schema: { type: 'number' } }]);
});
