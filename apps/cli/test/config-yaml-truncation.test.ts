import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '@matatbread/matbot-core';

// The config parser used to answer a construct it could not read by `break`ing its enclosing loop,
// which returned what had been read so far and left the rest of the document silently discarded. A
// bare `-` in `plugins:` — a plausible hand-editing artifact — dropped every plugin after it AND every
// top-level section below it, `providers:` included, with no error: an install that boots and behaves
// as though half its configuration had never been written.
//
// So the property under test is not "these inputs parse". It is that a config parser never returns a
// SUBSET of the file: it either reads the document or says which line it could not read.

test('a stray bare dash does not discard the rest of the config', () => {
  const doc = parseYaml(`plugins:
  - '@a/b'
  -
  - '@a/d'
providers:
  p:
    model: m
`);
  assert.deepEqual(doc['plugins'], ['@a/b', null, '@a/d']);
  assert.deepEqual(doc['providers'], { p: { model: 'm' } });
});

test('a bare dash takes the block indented beneath it as its value', () => {
  const doc = parseYaml(`plugins:
  - '@a/b'
  -
    '@a/c':
      k: v
  - '@a/d'
providers:
  p:
    model: m
`);
  assert.deepEqual(doc['plugins'], ['@a/b', { '@a/c': { k: 'v' } }, '@a/d']);
  assert.deepEqual(doc['providers'], { p: { model: 'm' } });
});

// Legal YAML this parser deliberately does not implement: telling `- key: value` from a plugin
// specifier needs the spec's colon-SPACE rule, without which `- https://host/p.ts` parses as a
// mapping keyed `https`. Rejecting it is the point — the alternative is not "it works", it is the
// silent subset above.
test('a compact mapping in a sequence entry is rejected, naming the line', () => {
  assert.throws(() => parseYaml(`plugins:
  - '@a/b'
  - '@a/c':
      k: v
  - '@a/d'
`), /line 4/);
});

test('a line that is not a mapping where one is required is rejected', () => {
  assert.throws(() => parseYaml(`providers:
  p:
    model: m
  oops
`), /line 4/);
});

test('a colon inside a value is not a key separator', () => {
  const doc = parseYaml(`plugins:
  - https://host/p.ts
  - ./plugins/bash
providers:
  p:
    endpoint: https://api.example.com
`);
  assert.deepEqual(doc['plugins'], ['https://host/p.ts', './plugins/bash']);
  assert.deepEqual(doc['providers'], { p: { endpoint: 'https://api.example.com' } });
});

// A quoted key kept its quotes, so `'@scope/pkg':` addressed a key literally spelled with them. Keys
// are scalars like any other; nothing hit it before because provider names are written bare, and
// package names — which are not — had no reason to be keys until `default_settings:`.
test('a quoted mapping key is unquoted', () => {
  assert.deepEqual(parseYaml(`default_settings:
  '@a/b':
    k: v
  "@a/c":
    k2: 2
`)['default_settings'], { '@a/b': { k: 'v' }, '@a/c': { k2: 2 } });
});

test('the forms already in use still parse unchanged', () => {
  // Flush-left sequence under a key, and both block scalar styles.
  const doc = parseYaml(`plugins:
- a
- b
system: |
  line one
  line two
folded: >
  one
  two
n: 1
`);
  assert.deepEqual(doc['plugins'], ['a', 'b']);
  assert.equal(doc['system'], 'line one\nline two\n');
  assert.equal(doc['folded'], 'one two');
  assert.equal(doc['n'], 1);
});
