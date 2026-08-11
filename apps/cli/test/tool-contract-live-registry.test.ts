import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts, checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// The scan's roots are a SUPERSET of the loaded plugins — a glob of the monorepo `plugins/` tree is unioned
// on to catch host-constructed builtins that have no resolvedUrl. So every plugin in the tree contributed a
// `ToolContracts` arm, loaded or not, and the dts declared tools that cannot be called: `tool.telegram_send`
// typechecked clean with no telegram frontend loaded and threw "not registered" at runtime. That is the one
// failure the check gate exists to prevent — the generated code is CORRECT against the types it was shown,
// so the repair loop cannot repair it, and skills_compiler's prompt asserts "a tool not declared here does
// not exist" over the same text.
//
// A scanned root may supply a tool's CONTRACT; only the registry says a tool EXISTS.
const root = join(import.meta.dirname, '..', '..', '..');

// Declared by `plugins/frontend/telegram`, `plugins/storage/profiles` and `plugins/docker-bash` — none of
// which this repo's matbot.yaml loads, all of which the glob reaches.
const UNLOADED = ['telegram_send', 'telegram_provider', 'telegram_open_door', 'profile_action', 'share', 'bash_config'];
const LIVE = ['bash', 'plugin', 'session_action'];

test('the dts declares the live registry, not every plugin on disk', async () => {
  const unfiltered = await buildMatbotToolsDts(root);
  assert.ok(unfiltered, 'expected the monorepo scan to produce a dts');
  // Vacuity guard: the filtered assertions below mean nothing unless the scan really did reach these.
  const declared = (b: NonNullable<typeof unfiltered>): string[] => [...b.tools.emitted, ...b.tools.unknown];
  assert.deepEqual(
    UNLOADED.filter(n => !declared(unfiltered).includes(n)), [],
    'these names must be reachable by the scan, else this test proves nothing',
  );

  const built = await buildMatbotToolsDts(root, [], LIVE);
  assert.ok(built);
  assert.deepEqual(declared(built).filter(n => !LIVE.includes(n)), [], 'no tool outside the live registry may be declared');
  assert.deepEqual(UNLOADED.filter(n => built.contracts[n] !== undefined), [], 'nor may one reach the wire contracts');
  // The glob's REASON survives the filter: `plugin` is constructed by the app, has no resolvedUrl, and is
  // reachable only through the glob — filtering by name must not cost it its types.
  assert.ok(built.contracts['plugin'], 'a host-constructed builtin keeps its scanned contract');
});

test('a tool no plugin registered is not callable through the proxy', async () => {
  const built = await buildMatbotToolsDts(root, [], LIVE);
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

  // Both directions, because ambient types that fail to resolve collapse to `any` and pass everything.
  assert.deepEqual(await check(`async function f() { return tool.bash({ script: 'ls' }); }`), [],
    'a live tool must still typecheck');
  assert.notDeepEqual(await check(`async function f() { return tool.telegram_send({ text: 'hi' }); }`), [],
    'an unloaded plugin\'s tool must not typecheck');
});
