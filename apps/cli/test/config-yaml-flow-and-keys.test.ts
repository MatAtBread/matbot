import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/yaml.js';

// A key ended at the first colon in its line, quoted or not, and flow syntax was read as a plain string —
// both silently. So `'deny:tool_function.import':` was the key `'deny`, and `'tools.overwrite': { '*': [a] }`
// was a string the permission gate ignored: every configured denial was unwritable, and the documented
// form of every configured answer was no answer.

test('a quoted key keeps its colons, and a plain key ends at a colon followed by a space', () => {
  assert.deepEqual(parseYaml(`'deny:tool_function.import':\n  x: 1\n"a:b": 2\nurl: https://host:8080/p\n`),
    { 'deny:tool_function.import': { x: 1 }, 'a:b': 2, url: 'https://host:8080/p' });
});

test('a line whose only colon is not followed by a space is not a key, and says so', () => {
  assert.throws(() => parseYaml(`a: 1\nb:2\n`), /line 2 .*no "key:"/);
  assert.throws(() => parseYaml(`b:2\n`), /line 1 .*must be a mapping/);
});

test('flow collections read as YAML has them, nested, with colons and commas inside quotes', () => {
  assert.deepEqual(parseYaml(`g:
  'tools.overwrite': { '*': [bash, plugin, '@acme/x *'] }
  'deny:tool_function.import': { '*': ['* node:child_process', "* a, b"] }
  n: [1, true, null, ~, x]
  e: { }
  trailing: [a, b, ]
`), { g: {
    'tools.overwrite': { '*': ['bash', 'plugin', '@acme/x *'] },
    'deny:tool_function.import': { '*': ['* node:child_process', '* a, b'] },
    n: [1, true, null, null, 'x'],
    e: {},
    trailing: ['a', 'b'],
  } });
});

test('a flow collection runs on until its brackets close, past comments', () => {
  assert.deepEqual(parseYaml(`d:
  '*': ['* node:child_process', '* node:module',   # builtins
        '* node:vm']
after: 1
`), { d: { '*': ['* node:child_process', '* node:module', '* node:vm'] }, after: 1 });
});

test('a flow value as a sequence item, and a plain value that only contains a colon', () => {
  assert.deepEqual(parseYaml(`s:\n  - [a, b]\n  - '* node:fs'\n  - https://host/x.ts\n`),
    { s: [['a', 'b'], '* node:fs', 'https://host/x.ts'] });
});

test('a block scalar is text, however its lines start', () => {
  assert.deepEqual(parseYaml(`system: |\n  Note: [see below\n  more\nnext: 1\n`),
    { system: 'Note: [see below\nmore\n', next: 1 });
});

test('a malformed flow collection fails, naming its line', () => {
  assert.throws(() => parseYaml(`a: 1\nb: [x, y\n`), /line 2/);
  assert.throws(() => parseYaml(`b: { k v }\n`), /":" was expected/);
  assert.throws(() => parseYaml(`b: [x] trailing\n`), /more after the collection/);
  assert.throws(() => parseYaml(`b: [x, , y]\n`), /entry is empty/);
});
