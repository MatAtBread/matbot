import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-core';
import { bootMachine } from '../../src/boot.ts';
import { parseConfig } from '../../src/config-parse.ts';

// The builtin `provider` tool used to be registered AFTER every plugin's setup, straight into the registry,
// so it overwrote any plugin that shadowed it: the shadow found no builtin to capture, then lost its name
// to it at the end of boot. `plugin` never had the problem — it is a builtinTool, in the registry before any
// plugin loads. Both are now. This boots the real machine, because the bug was the ORDER of boot's own
// steps, which no hand-built machine reproduces. One machine per process (assembleMachine refuses a
// second), so each case is a file: provider-tool-boot-shadow / provider-tool-boot-adapters.

/** Boot the CLI's machine on a matbot.yaml listing these plugins in order, each written as a package
 *  named by its key from its source (`API_VERSION` in it is replaced with the real one), then `yaml`. */
export async function bootWith(t: TestContext, plugins: Record<string, string>, yaml = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'matbot-provider-boot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(plugins)) {
    const pkg = path.join(dir, name);
    await mkdir(pkg);
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name, version: '1.0.0', type: 'module', matbotRuntime: ['node'], exports: './index.js',
    }));
    await writeFile(path.join(pkg, 'index.js'), source.replace('API_VERSION', JSON.stringify(PLUGIN_API_VERSION)));
  }
  const config = `plugins:\n${Object.keys(plugins).map(name => `  - ./${name}\n`).join('')}${yaml}`;
  const configPath = path.join(dir, 'matbot.yaml');
  await writeFile(configPath, config);
  return bootMachine({ config: configPath, ephemeral: true }, parseConfig(config), configPath);
}

export const FAKE_ADAPTER = `
  export const plugin = {
    apiVersion: API_VERSION,
    manifest: { description: 'the fake adapter for the boot test' },
    provider: () => ({ name: 'fake', async health() { return { ok: true }; }, async *complete() {} }),
  };
`;
