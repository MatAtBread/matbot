import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildMatbotToolsDts, collectToolTypeRoots } from '@matatbread/matbot-tool-types';

// The `plugins/` glob reaches plugins for every runtime, and `liveToolNames` cannot narrow it for a
// static caller, which has no live set (issue #110: a build-time typed client listed `webllm_models`,
// which no node host can load). So the glob applies the loader's own pre-import rule, against the
// runtime the build DESCRIBES — the web bundle's bake runs on node to describe a browser.
const root = join(import.meta.dirname, '..', '..', '..');

test('a node derivation leaves out browser-only plugins', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built);
  assert.equal(built.contracts['webllm_models'], undefined, 'webllm is matbotRuntime ["browser"]');
  assert.doesNotMatch(built.dts, /managedBy/, "google-drive's LoadedPluginSummary augmentation is browser-only");
  // Declared by both `frontend/dom` (browser) and `frontend/web` (node+browser): served on node by the latter.
  assert.ok(built.contracts['url_for_resource']);
  assert.ok(built.contracts['tool_router_config'], 'a ["node", "browser"] plugin is still scanned');
  assert.ok(built.contracts['plugin'] && built.contracts['provider']);
  assert.deepEqual(built.conflicts, []);
});

test('a browser derivation keeps them and leaves out node-only plugins', async () => {
  const built = await buildMatbotToolsDts(root, undefined, undefined, undefined, 'browser');
  assert.ok(built);
  assert.ok(built.contracts['webllm_models']);
  assert.match(built.dts, /managedBy/);
  assert.ok(built.contracts['url_for_resource']);
  assert.equal(built.contracts['bash'], undefined, 'bash is matbotRuntime ["node"]');
  assert.ok(built.contracts['plugin'] && built.contracts['provider']);
  assert.deepEqual(built.conflicts, []);
});

test('each file is judged by its nearest package, and absent or empty means no restriction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-runtime-roots-'));
  try {
    await mkdir(join(dir, 'plugin-api', 'src'), { recursive: true });
    await writeFile(join(dir, 'plugin-api', 'src', 'index.ts'), 'export {};\n');
    const augment = "declare module '@matatbread/matbot-plugin-api' { interface ToolContracts {} }\nexport {};\n";
    const pkg = async (path: string, runtimes?: string[]): Promise<void> => {
      await mkdir(join(dir, 'plugins', path, 'src'), { recursive: true });
      await writeFile(join(dir, 'plugins', path, 'package.json'),
        JSON.stringify(runtimes === undefined ? { name: path } : { name: path, matbotRuntime: runtimes }));
      await writeFile(join(dir, 'plugins', path, 'src', 'index.ts'), augment);
    };
    await pkg('browser-only', ['browser']);
    await pkg('browser-only/nested-node', ['node']);
    await pkg('both', ['node', 'browser']);
    await pkg('undeclared');
    await pkg('empty', []);

    const scanned = async (runtime: 'node' | 'browser'): Promise<string[]> =>
      ((await collectToolTypeRoots(dir, undefined, runtime))?.roots ?? [])
        .filter(f => f.includes('/plugins/'))
        .map(f => f.slice(join(dir, 'plugins').length + 1, -'/src/index.ts'.length))
        .sort();
    assert.deepEqual(await scanned('node'), ['both', 'browser-only/nested-node', 'empty', 'undeclared']);
    assert.deepEqual(await scanned('browser'), ['both', 'browser-only', 'empty', 'undeclared']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
