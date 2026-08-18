import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySpecifier, canonicalLocalSpecifier } from '@matatbread/matbot-tool-plugin';

// Five acquisition kinds collapsed to three routes, each delegating resolution to whoever owns it:
// local → the filesystem, npm → the package manager, http → the URL itself. Two of the old five were the
// same route reached by punctuation — a `.tgz` was `pnpm-url` while a directory URL was `remote`, and a
// `#path:` fragment switched mechanism on the strength of a `#`.

const RAW = 'https://raw.githubusercontent.com';

test('a URL is an answer: http, unless something must unpack it first', async () => {
  const cases: [string, 'http' | 'npm'][ ] = [
    ['https://esm.sh/some-plugin/',                     'http'],
    [`${RAW}/MatAtBread/matbot/refs/heads/main/plugins/storage/sqlite/`, 'http'],
    ['http://127.0.0.1:8080/p/',                        'http'],
    // nothing importable at the far end until it is unpacked or cloned — a package manager's job
    ['https://example.com/pkg-1.0.0.tgz',               'npm'],
    ['https://example.com/pkg.tar.gz',                  'npm'],
    ['https://github.com/owner/repo.git',               'npm'],
    ['git+ssh://git@github.com/owner/repo.git',         'npm'],
  ];
  for (const [spec, kind] of cases) {
    assert.equal((await classifySpecifier(spec, '/nonexistent')).kind, kind, spec);
  }
});

test('github: is plain http, and its subdirectory forms agree on one URL', async () => {
  const expect = async (spec: string, url: string) => {
    const c = await classifySpecifier(spec, '/nonexistent');
    assert.equal(c.kind, 'http', spec);
    assert.equal(c.kind === 'http' ? c.url : '', url, spec);
  };
  await expect('github:MatAtBread/matbot',            `${RAW}/MatAtBread/matbot/HEAD/`);
  await expect('github:MatAtBread/matbot#v1',         `${RAW}/MatAtBread/matbot/v1/`);
  await expect('github:MatAtBread/matbot/plugins/x',  `${RAW}/MatAtBread/matbot/HEAD/plugins/x/`);
  await expect('github:MatAtBread/matbot/plugins/x#v1', `${RAW}/MatAtBread/matbot/v1/plugins/x/`);
  // the legacy fragment resolves to the SAME url as the modern form it advises
  await expect('github:MatAtBread/matbot#path:plugins/x',    `${RAW}/MatAtBread/matbot/HEAD/plugins/x/`);
  await expect('github:MatAtBread/matbot#v1&path:plugins/x', `${RAW}/MatAtBread/matbot/v1/plugins/x/`);
});

// Matt's requirement for the taxonomy change: a specifier may stop working, but it must say what to
// replace it with. `#path:` keeps working AND says so.
test('a legacy #path: specifier advises the replacement that resolves identically', async () => {
  const c = await classifySpecifier('github:MatAtBread/matbot#path:plugins/storage/sqlite', '/nonexistent');
  assert.equal(c.kind, 'http');
  const advice = c.kind === 'http' ? c.advice ?? '' : '';
  assert.match(advice, /#path:/);
  assert.match(advice, /"github:MatAtBread\/matbot\/plugins\/storage\/sqlite"/, 'must name the replacement');
  // and the replacement it names classifies to the same URL, so following the advice changes nothing
  const rewritten = await classifySpecifier('github:MatAtBread/matbot/plugins/storage/sqlite', '/nonexistent');
  assert.equal(rewritten.kind === 'http' ? rewritten.url : 'x', c.kind === 'http' ? c.url : 'y');
  assert.equal(rewritten.kind === 'http' ? rewritten.advice : 'x', undefined, 'the modern form is not nagged about');
});

test('a bare name is checked on disk before the registry — scoped ones too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-classify-'));
  try {
    // `@scope/name` used to be assumed a registry name without ever looking
    await mkdir(join(dir, '@scope', 'name'), { recursive: true });
    await writeFile(join(dir, '@scope', 'name', 'package.json'), '{"name":"@scope/name"}');
    assert.equal((await classifySpecifier('@scope/name', dir)).kind, 'local');
    assert.equal((await classifySpecifier('@scope/absent', dir)).kind, 'npm');
    assert.equal((await classifySpecifier('debug', dir)).kind, 'npm');

    // `npm:` is the one override: go to the package manager even though the disk answers
    const forced = await classifySpecifier('npm:@scope/name', dir);
    assert.equal(forced.kind, 'npm');
    assert.equal(forced.kind === 'npm' ? forced.spec : '', '@scope/name', 'the prefix is stripped for the PM');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The case a path rule can never reach: a checkout's directory names have nothing to do with the
// package names inside them, so `@matatbread/matbot-edit-session` is `plugins/edit-session`. Installing
// it from the registry instead would put a published copy of on-disk code beside the source.
test('a bare name a local package DECLARES is local, wherever that package sits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-classify-name-'));
  try {
    const flat    = join(dir, 'plugins', 'edit-session');                 // plugins/<pkg>
    const grouped = join(dir, 'plugins', 'storage', 'sqlite');            // plugins/<group>/<pkg>
    for (const [at, name] of [[flat, '@matatbread/matbot-edit-session'], [grouped, '@matatbread/matbot-storage-sqlite']] as const) {
      await mkdir(at, { recursive: true });
      await writeFile(join(at, 'package.json'), JSON.stringify({ name }));
    }

    const found = await classifySpecifier('@matatbread/matbot-edit-session', dir);
    assert.equal(found.kind, 'local', 'the checkout answers, so the registry is not asked');
    assert.equal(found.kind === 'local' ? found.dir : '', flat);

    const nested = await classifySpecifier('@matatbread/matbot-storage-sqlite', dir);
    assert.equal(nested.kind === 'local' ? nested.dir : '', grouped, 'the grouped layout is two deep');

    // A name nothing here declares is still a registry question — that is the bare `npm i` install.
    assert.equal((await classifySpecifier('@matatbread/matbot-tool-mcp', dir)).kind, 'npm');
    // …and so is a version range, local package or not: a constraint is what a filesystem cannot solve.
    assert.equal((await classifySpecifier('@matatbread/matbot-edit-session@^0.4', dir)).kind, 'npm');
    assert.equal((await classifySpecifier('npm:@matatbread/matbot-edit-session', dir)).kind, 'npm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// This repo is the case that motivated it: every plugin must be addressable by the portable name.
test('this checkout resolves its own plugins by package name', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  for (const name of ['@matatbread/matbot-edit-session', '@matatbread/matbot-provider-anthropic']) {
    const c = await classifySpecifier(name, repo);
    assert.equal(c.kind, 'local', `${name} is in this checkout and must not come from the registry`);
  }
  assert.equal((await classifySpecifier('@matatbread/matbot-not-a-real-plugin', repo)).kind, 'npm');
});

// What `plugin add` records in matbot.yaml. A path is right only for one working copy; the name resolves
// here and in an installed deployment, and is the handle remove/reload use. But only when it leads back:
// a name that resolves elsewhere, or nowhere, would point the config at something else entirely.
test('a local plugin is recorded by name only when the name leads back to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-canonical-'));
  try {
    const inTree = join(dir, 'plugins', 'edit-session');
    await mkdir(inTree, { recursive: true });
    await writeFile(join(inTree, 'package.json'), JSON.stringify({ name: '@matatbread/matbot-edit-session' }));
    assert.equal(await canonicalLocalSpecifier(inTree, dir), '@matatbread/matbot-edit-session');

    // Outside the scanned root the name resolves nowhere, so the path stays: a compiled plugin, or a
    // sibling checkout reached by `../`.
    const outside = join(dir, 'compiled-plugins', 'thing');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'package.json'), JSON.stringify({ name: '@local/compiled-thing' }));
    assert.equal(await canonicalLocalSpecifier(outside, dir), undefined);

    // And a directory whose declared name belongs to a DIFFERENT package is not renamed into it.
    const impostor = join(dir, 'vendor', 'copy');
    await mkdir(impostor, { recursive: true });
    await writeFile(join(impostor, 'package.json'), JSON.stringify({ name: '@matatbread/matbot-edit-session' }));
    assert.equal(await canonicalLocalSpecifier(impostor, dir), undefined,
      'the name resolves to the in-tree package, not this one');

    // No name to record: nothing to prefer.
    const nameless = join(dir, 'plugins', 'nameless');
    await mkdir(nameless, { recursive: true });
    await writeFile(join(nameless, 'package.json'), '{}');
    assert.equal(await canonicalLocalSpecifier(nameless, dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a path shape with no package is still reported, never mis-routed to a registry', async () => {
  const c = await classifySpecifier('./definitely/not/here', '/nonexistent');
  assert.equal(c.kind, 'missing-path');
});
