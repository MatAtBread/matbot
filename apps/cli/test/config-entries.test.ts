import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginsList, readProviderModules, addPluginEntry, removePluginEntry } from '../src/plugins/config-entries.js';
import { parseConfig } from '../src/config-parse.js';

// The plugin list was read with regexes over the text, which disagreed with the parser boot uses: a
// comment line inside the list ended it, a quoted entry went unrecognised, and an entry with a trailing
// comment could not be removed. The property under test is that the entry functions see the list boot
// loads, and that an edit changes that list by exactly the one entry and leaves the rest of the text alone.

async function withConfig(text: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-config-entries-'));
  try {
    const file = join(dir, 'matbot.yaml');
    await writeFile(file, text);
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PROVIDERS = `providers:
  p:
    module: '@x/provider'
    model: m
`;

const COMMENTED = `plugins:
  - ./plugins/a
  # - ./plugins/off
  - ./plugins/b
  - '@x/quoted'
  - ./plugins/c  # note

${PROVIDERS}`;

test('every entry boot loads is read, past a comment line', async () => {
  await withConfig(COMMENTED, async file => {
    assert.deepEqual(await readPluginsList(file), ['./plugins/a', './plugins/b', '@x/quoted', './plugins/c']);
    assert.deepEqual(await readProviderModules(file), ['@x/provider']);
  });
});

test('a quoted entry counts as present', async () => {
  await withConfig(COMMENTED, async file => {
    assert.equal(await addPluginEntry(file, '@x/quoted'), false);
    assert.equal(await readFile(file, 'utf8'), COMMENTED);
  });
});

test('an entry with a trailing comment is removed, and only its line', async () => {
  await withConfig(COMMENTED, async file => {
    assert.equal(await removePluginEntry(file, './plugins/c'), true);
    assert.equal(await readFile(file, 'utf8'), COMMENTED.replace('  - ./plugins/c  # note\n', ''));
    assert.equal(await removePluginEntry(file, './plugins/c'), false);
  });
});

test('a quoted entry is removed', async () => {
  await withConfig(COMMENTED, async file => {
    assert.equal(await removePluginEntry(file, '@x/quoted'), true);
    assert.deepEqual(await readPluginsList(file), ['./plugins/a', './plugins/b', './plugins/c']);
  });
});

test('an append goes after the last entry, keeping comments where they were', async () => {
  await withConfig(COMMENTED, async file => {
    assert.equal(await addPluginEntry(file, './plugins/d'), true);
    assert.equal(await readFile(file, 'utf8'),
      COMMENTED.replace('  - ./plugins/c  # note\n', '  - ./plugins/c  # note\n  - ./plugins/d\n'));
  });
});

test('a name that is a prefix of a listed one is still added', async () => {
  await withConfig(`plugins:\n  - ./plugins/foobar\n`, async file => {
    assert.equal(await addPluginEntry(file, './plugins/foo'), true);
    assert.deepEqual(await readPluginsList(file), ['./plugins/foobar', './plugins/foo']);
  });
});

test('the same text under another key is neither present nor removable', async () => {
  const text = `plugins:\n  - ./plugins/a\nother:\n  - ./plugins/b\n`;
  await withConfig(text, async file => {
    assert.equal(await removePluginEntry(file, './plugins/b'), false);
    assert.equal(await addPluginEntry(file, './plugins/b'), true);
    assert.equal(await readFile(file, 'utf8'), `plugins:\n  - ./plugins/a\n  - ./plugins/b\nother:\n  - ./plugins/b\n`);
  });
});

test('a flush-left list keeps its column', async () => {
  await withConfig(`plugins:\n- ./plugins/a\n${PROVIDERS}`, async file => {
    await addPluginEntry(file, './plugins/b');
    assert.equal(await readFile(file, 'utf8'), `plugins:\n- ./plugins/a\n- ./plugins/b\n${PROVIDERS}`);
  });
});

test('a list is created where there is none, or under an empty key', async () => {
  await withConfig(PROVIDERS, async file => {
    await addPluginEntry(file, './plugins/a');
    assert.equal(await readFile(file, 'utf8'), `plugins:\n  - ./plugins/a\n\n${PROVIDERS}`);
  });
  await withConfig(`plugins:  # mine\n${PROVIDERS}`, async file => {
    await addPluginEntry(file, './plugins/a');
    assert.equal(await readFile(file, 'utf8'), `plugins:  # mine\n  - ./plugins/a\n${PROVIDERS}`);
  });
  await withConfig(`plugins: ~\n${PROVIDERS}`, async file => {
    await addPluginEntry(file, './plugins/a');
    assert.deepEqual(await readPluginsList(file), ['./plugins/a']);
  });
});

test('a specifier the parser would misread is written quoted', async () => {
  await withConfig(`plugins:\n  - ./plugins/a\n`, async file => {
    await addPluginEntry(file, 'https://host/p.ts #frag');
    assert.deepEqual(await readPluginsList(file), ['./plugins/a', 'https://host/p.ts #frag']);
    assert.equal(await removePluginEntry(file, 'https://host/p.ts #frag'), true);
    assert.deepEqual(await readPluginsList(file), ['./plugins/a']);
  });
});

test('CRLF line endings are kept', async () => {
  const text = `plugins:\r\n  - ./plugins/a\r\n${PROVIDERS.replaceAll('\n', '\r\n')}`;
  await withConfig(text, async file => {
    await addPluginEntry(file, './plugins/b');
    const written = await readFile(file, 'utf8');
    assert.equal(written.replaceAll('\r\n', '').includes('\n'), false);
    assert.deepEqual(parseConfig(written).plugins, ['./plugins/a', './plugins/b']);
  });
});
