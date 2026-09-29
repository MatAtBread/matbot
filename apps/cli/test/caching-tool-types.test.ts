import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPrincipalCarrier, runAs } from '@matatbread/matbot-core';
import type { PluginSettings } from '@matatbread/matbot-plugin-api';
import { cachingFill } from '@matatbread/matbot-caching-tool-types';
import { buildToolTypesData, compileToolValidators, filterToolTypesData } from '@matatbread/matbot-tool-types';
import type { ToolTypesData, ToolTypesFill, ToolTypesInputs } from '@matatbread/matbot-tool-types';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());

// A stored build is only as good as the check that it still describes the inputs. These run the fill
// directly: the index around it (one build shared by callers that meet, rebuild on a registry change)
// is tool-types' and has its own tests.
const repo   = join(import.meta.dirname, '..', '..', '..');
const whoami = `file://${join(repo, 'plugins', 'whoami', 'src', 'index.ts')}`;
const askUser = `file://${join(repo, 'plugins', 'ask-user', 'src', 'index.ts')}`;

// Settings are a JSON medium; round-tripping here is what proves a build survives being stored.
function settings(): PluginSettings {
  const m = new Map<string, string>();
  return {
    get: async <T>(k: string) => (m.has(k) ? JSON.parse(m.get(k)!) as T : undefined),
    set: async <T>(k: string, v: T) => { m.set(k, JSON.stringify(v)); },
    delete: async (k: string) => { m.delete(k); },
    all: async () => Object.fromEntries([...m].map(([k, v]) => [k, JSON.parse(v)])),
  } as PluginSettings;
}

async function project() {
  const dir  = await mkdtemp(join(tmpdir(), 'caching-tool-types-'));
  const file = join(dir, 'read-by-the-build.ts');
  await writeFile(file, 'export const x = 1;\n');
  return { dir, file };
}

function inputs(projectRoot: string, over: Partial<ToolTypesInputs> = {}): ToolTypesInputs {
  return { projectRoot, pluginEntryUrls: [whoami], liveToolNames: ['whoami'], syntheticContracts: {}, ...over };
}

// Stands in for the ~2 s build: counts calls and reports one file as read.
function fakeBuild(file: string) {
  let builds = 0;
  const build: ToolTypesFill = async () => {
    builds++;
    return {
      dts: `// build ${builds}`, dtsParts: { head: '', tools: {}, tail: '' },
      tools: { emitted: [], unknown: [] }, services: { emitted: [], unknown: [] },
      conflicts: [], contracts: {}, validators: {}, apiExports: [], files: [file],
    } satisfies ToolTypesData;
  };
  return { build, builds: () => builds };
}

test('a real build survives storage and its validators still work', async () => {
  const { dir } = await project();
  try {
    const store = settings();
    const first = await cachingFill(store)(inputs(dir));
    assert.ok(first?.validators['whoami'], 'the real build derives a validator for whoami');

    const again = await cachingFill(store, async () => { throw new Error('should have been a hit'); })(inputs(dir));
    assert.deepEqual(again, JSON.parse(JSON.stringify(first)));

    const v = compileToolValidators(again!.validators)['whoami']!;
    assert.ok('validate' in v);
    assert.deepEqual(v.validate({}), []);
    assert.notDeepEqual(v.validate({ unexpected: 1 }), [], 'a stored validator still rejects an excess key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same inputs, with nothing on disk changed, do not build', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const fill = cachingFill(settings(), build);
    const a = await fill(inputs(dir));
    const b = await fill(inputs(dir));
    assert.equal(builds(), 1);
    assert.equal(b?.dts, a?.dts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file the build read changing is a miss', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const fill = cachingFill(settings(), build);
    await fill(inputs(dir));
    await writeFile(file, 'export const x = 2;\n');
    await fill(inputs(dir));
    assert.equal(builds(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a moved mtime over unchanged content is still a hit', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const fill = cachingFill(settings(), build);
    await fill(inputs(dir));
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    await fill(inputs(dir));
    assert.equal(builds(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a different synthetic contract or principal is a miss', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const fill = cachingFill(settings(), build);
    await fill(inputs(dir));
    await fill(inputs(dir, { syntheticContracts: { fn: 'ToolContract<string, {}>' } }));
    assert.equal(builds(), 2);
    await runAs({ id: 'someone-else', type: 'user' }, () =>
      fill(inputs(dir, { syntheticContracts: { fn: 'ToolContract<string, {}>' } })));
    assert.equal(builds(), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Tools arrive after boot (every `mcp__*` one), each bumping the index's generation. That has to be a
// filter over what is stored: the build is made over every scanned tool, and the live set narrows it.
test('a tool added or removed is a filter, not a rebuild', async () => {
  const { dir } = await project();
  try {
    let builds = 0;
    const fill = cachingFill(settings(), async i => { builds++; return buildToolTypesData(i.projectRoot, i.pluginEntryUrls, i.liveToolNames, i.syntheticContracts); });
    const both = { pluginEntryUrls: [whoami, askUser] };

    const one = await fill(inputs(dir, { ...both, liveToolNames: ['whoami'] }));
    assert.deepEqual(Object.keys(one!.validators), ['whoami']);
    assert.doesNotMatch(one!.dts, /ask_user/);

    const two = await fill(inputs(dir, { ...both, liveToolNames: ['ask_user', 'whoami', 'mcp__x__y'] }));
    assert.deepEqual(Object.keys(two!.validators).sort(), ['ask_user', 'whoami']);
    assert.match(two!.dts, /ask_user/);

    await fill(inputs(dir, { ...both, liveToolNames: [] }));
    assert.equal(builds, 1, 'one build served all three live sets');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// No roots means nothing a key could describe, so there is nothing to store either.
test('nothing to scan passes straight through to the build', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const fill = cachingFill(settings(), build);
    await fill(inputs(dir, { pluginEntryUrls: [] }));
    await fill(inputs(dir, { pluginEntryUrls: [] }));
    assert.equal(builds(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Filtering must not be a second way to get a different answer: a build narrowed after the fact matches
// one made narrow, but for the head's surplus declarations.
test('filtering an unfiltered build matches building filtered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-types-filter-'));
  try {
    const urls = [whoami, askUser];
    const live = ['whoami'];
    const narrow   = await buildToolTypesData(dir, urls, live);
    const filtered = filterToolTypesData((await buildToolTypesData(dir, urls))!, live);
    assert.ok(narrow);
    assert.deepEqual(filtered.dtsParts.tools, narrow.dtsParts.tools);
    assert.equal(filtered.dtsParts.tail, narrow.dtsParts.tail);
    assert.deepEqual(filtered.tools, narrow.tools);
    assert.deepEqual(filtered.contracts, narrow.contracts);
    assert.deepEqual(filtered.validators, narrow.validators);
    assert.deepEqual(filtered.conflicts, narrow.conflicts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A build asked for before the last plugin loads scans fewer roots than one asked for after. With one
// slot each overwrote the other, so every restart missed twice; each root set keeps its own.
test('restarts that meet both a partial and a full plugin set build each only once', async () => {
  const { dir, file } = await project();
  try {
    const { build, builds } = fakeBuild(file);
    const store = settings();
    const settle = () => new Promise(r => setImmediate(r));
    for (let restart = 0; restart < 3; restart++) {
      const fill = cachingFill(store, build);                       // a new process
      await fill(inputs(dir, { pluginEntryUrls: [whoami] }));        // before the late plugin
      await fill(inputs(dir, { pluginEntryUrls: [whoami, askUser] })); // after it
      await settle();
    }
    assert.equal(builds(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
