import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-core';
import { bootMachine } from '../../src/boot.ts';
import { parseConfig } from '../../src/config-parse.ts';

// The builtin `provider` tool used to be registered AFTER every plugin's setup, straight into the registry,
// so it overwrote any plugin that shadowed it: the shadow found no builtin to capture, then lost its name
// to it at the end of boot. `plugin` never had the problem — it is a builtinTool, in the registry before any
// plugin loads. Both are now. This boots the real machine, because the bug was the ORDER of boot's own
// steps, which no hand-built machine reproduces. One machine per process (assembleMachine refuses a
// second), so each case is a file: provider-tool-boot-shadow / provider-tool-boot-adapters.

/** Boot the CLI's machine on a matbot.yaml listing one plugin, written as a package from `source`. */
export async function bootWith(name: string, source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'matbot-provider-boot-'));
  const pkg = path.join(dir, name);
  await mkdir(pkg);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', matbotRuntime: ['node'], exports: './index.js',
  }));
  await writeFile(path.join(pkg, 'index.js'), source.replace('API_VERSION', JSON.stringify(PLUGIN_API_VERSION)));
  const yaml = `plugins:\n  - ./${name}\n`;
  const configPath = path.join(dir, 'matbot.yaml');
  await writeFile(configPath, yaml);
  return bootMachine({ config: configPath, ephemeral: true }, parseConfig(yaml, dir), configPath);
}
