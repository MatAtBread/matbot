import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistryImpl, copyTool } from '@matatbread/matbot-core';
import type { Notifier, Tool } from '@matatbread/matbot-plugin-api';

// A plugin's tool that displaced the host's is withdrawn back to it. One that displaced another plugin's
// is not: plugins come and go independently, so there may be nothing live to go back to.

const tool = (name: string, pluginName?: string, description = `${name} from ${pluginName ?? 'the host'}`): Tool => ({
  name, description, inputSchema: { type: 'object' },
  ...(pluginName !== undefined ? { pluginName } : {}),
  executor: { async *execute() { yield { type: 'result', value: description }; } },
});

function registry(initial: Tool[] = []) {
  const said: string[] = [];
  const notifier = {
    notify: (n: { name: string; operation: string; detail?: { pluginName?: string } }) => {
      said.push(`${n.operation} ${n.name}${n.detail?.pluginName !== undefined ? ` by ${n.detail.pluginName}` : ''}`);
    },
  } as unknown as Notifier;
  return { tools: new ToolRegistryImpl(initial, notifier), said };
}

test("unloading the plugin that shadowed a built-in reinstates the built-in", () => {
  const { tools, said } = registry([tool('provider')]);
  tools.register(tool('provider', 'shadow'));
  assert.equal(tools.resolve('provider')?.pluginName, 'shadow');

  tools.removeByPlugin('shadow');
  assert.equal(tools.resolve('provider')?.description, 'provider from the host');
  assert.deepEqual(said, ['added provider by shadow', 'added provider']);
});

test("removing a plugin's tool reinstates the built-in it displaced; removing the built-in removes it", () => {
  const { tools, said } = registry();
  tools.register(tool('about'));            // as assembleMachine registers core's own tools
  tools.register(tool('about', 'p'));
  said.length = 0;

  tools.remove('about');
  assert.equal(tools.resolve('about')?.pluginName, undefined);
  tools.remove('about');
  assert.equal(tools.resolve('about'), null);
  assert.deepEqual(said, ['added about', 'removed about']);

  tools.register(tool('about', 'p'));
  tools.remove('about');
  assert.equal(tools.resolve('about'), null, 'a removed built-in is not reinstated later');
});

test("a plugin's tool another plugin displaced is gone, not suspended", () => {
  const { tools } = registry([tool('bash')]);
  tools.register(tool('bash', 'bash'));
  tools.register(tool('bash', 'docker-bash'));

  tools.removeByPlugin('bash');
  assert.equal(tools.resolve('bash')?.pluginName, 'docker-bash', 'withdrawing a replaced plugin changes nothing');
  tools.removeByPlugin('docker-bash');
  assert.equal(tools.resolve('bash')?.pluginName, undefined, 'past both plugins, to the built-in — not to `bash`');
});

test('a getter survives the copies the host makes of a tool', () => {
  let adapters = 'none';
  const live: Tool = { ...tool('provider'), get description() { return `adapters: ${adapters}`; } };
  const judged = new ToolRegistryImpl([live], undefined, async () => undefined);
  const stamped = copyTool(judged.resolve('provider')!, { pluginName: 'p' });

  adapters = 'fake';
  assert.equal(judged.resolve('provider')?.description, 'adapters: fake', 'through the validating wrapper');
  assert.equal(stamped.description, 'adapters: fake', 'through an owner stamp');
  assert.equal(stamped.pluginName, 'p');
});
