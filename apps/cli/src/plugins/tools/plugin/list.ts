import type { ToolEvent, ToolResultOf } from '@matatbread/matbot-core';
import { describePlugins }             from '@matatbread/matbot-core';
import path                            from 'node:path';
import { readPluginsList }             from '../../config-entries.js';
import { findDuplicateSingletons }     from '../../singletons.js';

export async function* listPlugins(configPath: string): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const projectDir = path.dirname(configPath);
  const listed = describePlugins();
  // Reported alongside failures because it is the same kind of fact — something about the installed
  // set that is worth knowing and that nothing else would ever mention. It is not a failure: a second
  // copy of a singleton is survivable by design, which is exactly why it would otherwise go unnoticed.
  const duplicateSingletons = findDuplicateSingletons({ configDir: projectDir, plugins: listed.loaded });
  yield {
    type:  'result',
    value: {
      ...listed,
      configured: await readPluginsList(configPath),
      ...(duplicateSingletons.length ? { duplicateSingletons } : {}),
    },
  };
}
