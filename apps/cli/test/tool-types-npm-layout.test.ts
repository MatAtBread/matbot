import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildToolTypesData } from '@matatbread/matbot-tool-types';

// Issue #121: installed from npm, every matbot package lives under node_modules, and plugin-api's directory
// is `matbot-plugin-api`. tool-types told plugin-api from a plugin by a `/plugin-api/` path fragment and
// "external" from "ours" by `/node_modules/`, both of which hold only in the monorepo — so an install got no
// source-declared contracts, and would have bundled no plugin's own types nor expanded any wire text.
//
// The packages are COPIED, not symlinked: TypeScript resolves a symlink to its target, which in this repo is
// `<repo>/plugin-api/…`, and the fragment would match again — the layout under test would never be built.
test('an npm-shaped install types, validates and describes source-declared tools', { timeout: 60000 }, async t => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mb-npm-layout-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const scope = join(root, 'node_modules', '@matatbread');
  const install = (from: string, name: string): string => {
    const to = join(scope, name);
    cpSync(join(repo, from), to, { recursive: true, filter: src => !/[\\/](node_modules|dist)$/.test(src) });
    return to;
  };
  install('plugin-api', 'matbot-plugin-api');
  install('core', 'matbot-core');
  const functionTools = install(join('plugins', 'function-tools'), 'matbot-function-tools');

  const data = await buildToolTypesData(
    root, [pathToFileURL(join(functionTools, 'src', 'index.ts')).href], ['tool_function', 'plugin'],
  );
  assert.ok(data, 'a build over the installed packages');

  // The ToolContracts augmentation is found, so the tool is typed and validated at all.
  assert.ok(data.validators['tool_function'], `validators: ${Object.keys(data.validators).join(', ')}`);
  assert.ok(!('refused' in data.validators['tool_function']!), JSON.stringify(data.validators['tool_function']));
  assert.ok(data.tools.emitted.includes('tool_function'), `emitted: ${data.tools.emitted.join(', ')}`);

  // A type of the installed plugin's own is bundled into the dts, not left as `unknown`.
  assert.match(data.dts, /interface FunctionRecord\b/);
  assert.doesNotMatch(data.dts, /FunctionRecord \(external\)/);

  // plugin-api's own types are imported by name, as they are from the monorepo.
  assert.match(data.dts, /import type \{[^}]*\bPluginToolContract\b[^}]*\} from '@matatbread\/matbot-plugin-api'/);
  assert.match(data.dts, /\bplugin: PluginToolContract;/);

  // Wire text expands named shapes, plugin-api's and the plugin's own, so the model reads their fields.
  const fnResult = data.contracts['tool_function']?.result ?? '';
  assert.doesNotMatch(fnResult, /\bFunctionRecord\b/, fnResult);
  const pluginResult = data.contracts['plugin']?.result ?? '';
  assert.ok(pluginResult.length > 0, 'plugin has a wire contract');
  assert.doesNotMatch(pluginResult, /\bLoadedPluginSummary\b/, pluginResult);
});
