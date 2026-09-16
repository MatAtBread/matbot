import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireDescription } from '@matatbread/matbot-core';

// Every tool's description carries its flattened wire contract, and this is the text the MODEL reads —
// on every tool, every turn. The result block used to omit the newline after its label and before its
// fence ("TypeScript result:```{ ok: boolean }"), so the fence never opened where a reader expects and
// the block did not close. Nothing typechecks prose, so the property is pinned here instead.

const params = '{ action: "get"; id: string }';
const result = '{ ok: boolean }';

test('both contract blocks are well-formed fenced code', () => {
  const out = wireDescription('does a thing', { params, result });

  assert.match(out, /^does a thing\n\n/, 'the description leads');
  // A label, then a newline, then the fence — for both blocks, identically.
  assert.ok(out.includes(`TypeScript params:\n\`\`\`\n${params}\n\`\`\``), 'params block');
  assert.ok(out.includes(`TypeScript result:\n\`\`\`\n${result}\n\`\`\``), 'result block');

  // Four fences, so both blocks close. A label glued to its fence reads as three.
  assert.equal(out.split('```').length - 1, 4, 'two opened and two closed fences');
  for (const line of out.split('\n')) {
    assert.ok(line === '```' || !line.includes('```'), `a fence must own its line, got ${JSON.stringify(line)}`);
  }
});

test('a tool with no contract keeps its description untouched', () => {
  assert.equal(wireDescription('just prose', undefined), 'just prose');
});
