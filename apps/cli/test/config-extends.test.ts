import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '@matatbread/matbot-core';

// `extends:` merges per TOP-LEVEL KEY and the derived document REPLACES the section it names — a child
// declaring one plugin supplies the whole list. The word "extends" invites the other reading, and the
// behaviour is one spread with nothing naming it, so it is pinned here: change it on purpose.

const base = `plugins:
  - '@a/one'
  - '@a/two'
providers:
  basep:
    module: '@a/prov'
    model: m1
default_provider: basep
`;

test('a section the child declares replaces the base section entirely', () => {
  const config = parseConfig(`plugins:
  - '@a/three'
`, base);

  assert.deepEqual(config.plugins, ['@a/three'], 'the base plugins are NOT appended');
  assert.deepEqual([...config.providers.keys()], ['basep'], 'a section the child omits is inherited whole');
  assert.equal(config.defaultProvider, 'basep');
});

test('a section the child omits is inherited, and scalars override', () => {
  const config = parseConfig(`default_provider: mine
providers:
  mine:
    module: '@a/prov'
    model: m2
`, base);

  assert.deepEqual(config.plugins, ['@a/one', '@a/two'], 'plugins came from the base');
  assert.deepEqual([...config.providers.keys()], ['mine'], 'providers is replaced, not merged per entry');
  assert.equal(config.defaultProvider, 'mine');
});

test('with no base, the document stands alone', () => {
  const config = parseConfig(`plugins:
  - '@a/solo'
`);
  assert.deepEqual(config.plugins, ['@a/solo']);
  assert.equal(config.providers.size, 0);
});
