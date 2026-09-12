import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeToolContract } from '../../../plugins/tool-store/src/index.ts';

// Split on a top-level `|` exactly as build-dts and the wire projection do, so a test failure here is
// a failure there.
function arms(contract: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < contract.length; i++) {
    const c = contract[i];
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && c === '|') { out.push(contract.slice(start, i).trim()); start = i + 1; }
  }
  out.push(contract.slice(start).trim());
  return out;
}

const SHAPE = 'interface Note { label: string; note?: string }';

test('one arm per action, so ToolProxy becomes an overload set', () => {
  // A single arm is a single call signature with nothing to overload: the declared result was the
  // union across every action, and no action's own fields were reachable without a guard.
  const a = arms(storeToolContract(SHAPE));
  assert.equal(a.length, 5);
  assert.ok(a.every(arm => arm.startsWith('ToolContract<')), 'every arm is a literal ToolContract');
  assert.deepEqual(
    a.map(arm => arm.match(/action: '(\w+)'/)?.[1]),
    ['get', 'set', 'cas', 'delete', 'query'],
  );
});

test('each arm declares its own result, not the union across actions', () => {
  const [get, set, cas, del, query] = arms(storeToolContract(SHAPE));
  assert.match(get ?? '', /^ToolContract<\(\(\{ label: string; note\?: string \}\) & \{ id: string; version: string \}\) \| null,/);
  assert.ok(!(set ?? '').includes('deleted'), 'a set result must not carry the delete arm');
  assert.match(cas ?? '', /ok: true; doc:/);
  assert.match(del ?? '', /^ToolContract<\{ deleted: boolean \},/);
  assert.match(query ?? '', /items:/);
});

test('a write accepts `id`/`version`, a read declares them present', () => {
  // `get` hands back a document carrying `version`; sending it straight to `set` used to be rejected
  // as an unexpected property, so every update had to be rebuilt field by field — and `set` replaces,
  // so whatever the rebuild forgot was silently deleted.
  const [, set, cas] = arms(storeToolContract(SHAPE));
  for (const arm of [set, cas]) assert.match(arm ?? '', /data: \(\(.+\) & \{ id\?: string; version\?: string \}\)/);
  assert.match(arms(storeToolContract(SHAPE))[0] ?? '', /& \{ id: string; version: string \}/);
});

test('the document type is parenthesised against both `[]` and `|`', () => {
  // `[]` binds tighter than `&`, so an unwrapped `stored[]` parses as `doc & ({id;version}[])` — an
  // intersection with an array whose ELEMENT type has lost the document. It typechecks, and is wrong.
  const query = arms(storeToolContract(SHAPE))[4] ?? '';
  assert.ok(query.includes('version: string })[]'), `array element must close its parens first: ${query}`);

  // Same reason on the other side: `&` binds tighter than `|`, so a union shape must be wrapped too.
  const union = storeToolContract('type Doc = { kind: "a"; a: string } | { kind: "b"; b: number };');
  assert.ok(union.includes('(({ kind: "a"; a: string } | { kind: "b"; b: number }) &'),
            `a union shape must be wrapped before the intersection: ${union}`);
});
