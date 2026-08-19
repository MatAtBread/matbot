import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { buildMatbotToolsDts, checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// Nothing in this repo compiled the artefact the generator produces, and that is the gap this file closes.
// `pnpm typecheck` compiles each plugin separately, so two file-local types never meet; `check:contracts`
// reads contracts against inputSchemas and never compiles the dts; and the checker deliberately DROPS every
// diagnostic inside the ambient prefix (`d.start >= prefixLen`) on the grounds that a broken prefix is our
// bug and not the snippet's — true, and exactly why our bug was inaudible.
//
// Measured before the fix: `background` and `edit-session` each declare a file-local `SkipKind`, the bundler
// keyed its map by declaration identity, and both landed in one flat scope. TS2300 twice, every reference to
// either resolving to an error type, and the narrowing both plugins' comments tell callers to rely on
// ("branch on `kind`, never on the prose") silently gone wherever a generator is graded against the dts.
//
// So the gate is one assertion — compile the emitted dts AS source, with `prefixLen: 0` so nothing is
// filtered — and it is what separates "the contracts resolve" from "the contracts appear to resolve".
const root         = join(import.meta.dirname, '..', '..', '..');
const apiIndexPath = join(root, 'plugin-api', 'src', 'index.ts');

const compile = (dts: string): Promise<string[]> =>
  checkSnippetAgainst({ root, source: dts, prefixLen: 0, prefixLines: 0, apiIndexPath });

test('the emitted dts compiles', async () => {
  // Unfiltered on purpose: the roots are a superset of the loaded set, so this covers every plugin on disk.
  // A collision between two plugins that this config does not load is still one the next config meets.
  const built = await buildMatbotToolsDts(root);
  assert.ok(built, 'expected the monorepo scan to produce a dts');
  assert.deepEqual(await compile(built.dts), [], 'the derived dts must compile clean');
});

// The pair is written to a temp dir rather than `test/fixtures/`, and it is the module specifier that
// forces it: an augmentation only merges if `@matatbread/matbot-plugin-api` RESOLVES from the file
// declaring it, and under pnpm's isolated layout it does not resolve from anywhere under `apps/cli`.
// A file where it fails declares a fresh ambient module instead, silently contributing nothing — so the
// symlink is what makes this test test anything. Outside the tree, too, so a `plugins/` glob in another
// test file can never see these two.
const SHAPES = { a: `'granted' | 'refused'`, b: `'deferred' | 'lost'` };

const withFixtures = async (fn: (urls: string[]) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-dup-local-'));
  try {
    await mkdir(join(dir, 'node_modules', '@matatbread'), { recursive: true });
    await symlink(join(root, 'plugin-api'), join(dir, 'node_modules', '@matatbread', 'matbot-plugin-api'), 'dir');
    const urls: string[] = [];
    for (const [n, shape] of Object.entries(SHAPES)) {
      const file = join(dir, `dup-local-type-${n}.ts`);
      // Same local type NAME in both, different shapes — the legal, deliberate case the tree already has.
      await writeFile(file, [
        `import type { ToolContract } from '@matatbread/matbot-plugin-api';`,
        `type Outcome = ${shape};`,
        `declare module '@matatbread/matbot-plugin-api' {`,
        `  interface ToolContracts {`,
        `    dup_local_${n}: ToolContract<{ outcome: Outcome }, { action: '${n}' }>;`,
        `  }`,
        `}`,
      ].join('\n'));
      urls.push(pathToFileURL(file).href);
    }
    await fn(urls);
  } finally { await rm(dir, { recursive: true, force: true }); }
};

test('two plugins may declare the same local type name, and each keeps its own', async () => {
  await withFixtures(async urls => {
    const built = await buildMatbotToolsDts(root, urls, ['dup_local_a', 'dup_local_b']);
    assert.ok(built);

    // Vacuity guard: everything below proves nothing unless both arms really did reach the dts.
    assert.deepEqual([...built.tools.emitted].sort(), ['dup_local_a', 'dup_local_b'],
      'both fixture arms must be emitted, else the collision is never exercised');
    assert.deepEqual(await compile(built.dts), [], 'a duplicated local type name must not break the dts');

    const prefix = `${built.dts}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`;
    const check  = (snippet: string): Promise<string[]> => checkSnippetAgainst({
      root, apiIndexPath,
      source:      `${prefix}${snippet}\nexport {};\n`,
      prefixLen:   prefix.length,
      prefixLines: prefix.split('\n').length - 1,
    });
    const assignToA = (n: string): string =>
      `async function f() { const r = await tool.dup_local_${n}({ action: '${n}' }); const x: ${SHAPES.a} = r.outcome; return x; }`;

    // Both directions. Renaming one of the two out of the collision is only correct if the references
    // followed it, and a duplicate identifier resolves to an ERROR type, which is assignable to anything —
    // so the negative case is the one that fails without the fix; the positive case passes either way.
    assert.deepEqual(await check(assignToA('a')), [], "a's own union must still be assignable");
    assert.notDeepEqual(await check(assignToA('b')), [], "b's union must NOT be assignable to a's");
  });
});
