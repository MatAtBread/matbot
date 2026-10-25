import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyParser, type Piece } from '../../../plugins/providers/webllm/src/format.ts';

// Reading Qwen's `<tool_call>` reply, on a phone-sized model.
//
// Measured on Qwen3-1.7B-q4f16_1-MLC, whose whole reply to "what tools do you have?" was:
//
//   <think>\n\n</think>\n\n{"name": "tool_search", "arguments": {"query": "List the tools I have"}}
//
// A complete, well-formed call — with the two `<tool_call>` tags its prompt showed it missing. So the
// structural tag never fired (it constrains only what follows the literal), the parser found no marker,
// and the call arrived as JSON in a text bubble while the tool it meant to call was never called.
//
// Two other faults are covered here because they are the same fault seen from elsewhere: a call the
// reply ended inside was executed with `{}` for its arguments (a real side effect from a formatting
// slip), and a call written inside an unclosed `<think>` block was swallowed as reasoning.

/** Every prefix-chunking of `s`, so a marker split across chunks is covered wherever it lands. */
function everyChunking(s: string): string[][] {
  const out: string[][] = [];
  for (let size = 1; size <= s.length; size++) {
    const chunks: string[] = [];
    for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
    out.push(chunks);
  }
  return out;
}

function parse(chunks: readonly string[], bareCalls?: boolean): Piece[] {
  const parser = new ReplyParser(bareCalls === undefined ? {} : { bareCalls });
  const pieces: Piece[] = [];
  for (const c of chunks) pieces.push(...parser.push(c));
  pieces.push(...parser.end());
  // Adjacent runs of the same text kind are one run: a chunk boundary is not a semantic one.
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (last && last.kind === p.kind && (p.kind === 'text' || p.kind === 'thinking')) {
      last.text += p.text;
    } else merged.push({ ...p });
  }
  return merged;
}

function assertAtEveryChunking(reply: string, want: Piece[], opts?: boolean): void {
  for (const chunks of everyChunking(reply)) {
    assert.deepEqual(parse(chunks, opts), want, `chunks of ${JSON.stringify(reply)}: ${JSON.stringify(chunks)}`);
  }
}

test('a call with its tags missing is still a call', () => {
  // The exact reply that started this. A tool call, not JSON in a text bubble.
  assertAtEveryChunking(
    '<think>\n\n</think>\n\n{"name": "tool_search", "arguments": {"query": "List the tools I have"}}',
    [{ kind: 'call', name: 'tool_search', arguments: { query: 'List the tools I have' } }],
  );
});

test('prose before a bare call is kept, and the call still read', () => {
  assert.deepEqual(
    parse(['Let me look. ', '{"name": "tool_search", "arguments": {"query": "x"}}']),
    [{ kind: 'text', text: 'Let me look.' }, { kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('a bare call is read even when the think block never closed', () => {
  // Without the call ending reasoning, this whole thing is `thinking`: invisible with thinking off.
  assertAtEveryChunking(
    '<think>I should search.\n{"name": "tool_search", "arguments": {"query": "x"}}',
    [{ kind: 'thinking', text: 'I should search.' },
     { kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('a wrapped call ends an unclosed think block rather than being swallowed', () => {
  assertAtEveryChunking(
    '<think>I should search.\n<tool_call>\n{"name": "tool_search", "arguments": {"query": "x"}}\n</tool_call>',
    [{ kind: 'thinking', text: 'I should search.' },
     { kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('a call that will not parse is reported, never turned into a call with no arguments', () => {
  // The body is malformed (`arguments:` is not a key). Executing this would run the tool with `{}` — a real
  // side effect from a formatting slip, and what a broken call used to look like from outside.
  assert.deepEqual(
    parse(['<tool_call>\n{"name": "tool_search", arguments: {"query": }}\n</tool_call>']),
    [{ kind: 'unparsed-call', name: 'tool_search', body: '\n{"name": "tool_search", arguments: {"query": }}\n' }],
  );
});

test('a reply cut off inside a call is still a cut call, not an unparsed one', () => {
  const cut = parse(['<tool_call>\n{"name": "tool_search", "arguments": {"query": "x"']);
  assert.equal(cut.length, 1);
  assert.equal(cut[0]!.kind, 'cut-call');
  assert.equal((cut[0] as { name: string }).name, 'tool_search');
});

test('a call whose closing tag is what got cut is a call', () => {
  // The JSON closed, so the arguments are whole: only `</tool_call>` is missing.
  assert.deepEqual(
    parse(['<tool_call>\n{"name": "tool_search", "arguments": {"query": "x"}}']),
    [{ kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('arguments arrive as an object whichever form the model wrote', () => {
  // Qwen's own template accepts both, and a small build picks either.
  const asObject = [{ kind: 'call', name: 'tool_search', arguments: { query: 'x' } }];
  assert.deepEqual(parse(['<tool_call>\n{"name": "tool_search", "arguments": {"query": "x"}}\n</tool_call>']), asObject);
  assert.deepEqual(parse(['<tool_call>\n{"name": "tool_search", "arguments": "{\\"query\\": \\"x\\"}"}\n</tool_call>']), asObject);
  assert.deepEqual(parse(['{"name": "tool_search", "arguments": "{\\"query\\": \\"x\\"}"}']), asObject);
});

test('a trailing comma is repaired', () => {
  assert.deepEqual(
    parse(['{"name": "tool_search", "arguments": {"query": "x",},}']),
    [{ kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('parallel calls written as a list are read as calls, bracket included', () => {
  assert.deepEqual(
    parse(['[{"name": "a", "arguments": {"x": 1}}, {"name": "b", "arguments": {"y": 2}}]']),
    [{ kind: 'call', name: 'a', arguments: { x: 1 } }, { kind: 'call', name: 'b', arguments: { y: 2 } }],
  );
});

test('the tags as a model writes them: spaced, and `<toolcall>`', () => {
  const want = [{ kind: 'call', name: 'tool_search', arguments: { query: 'x' } }];
  assert.deepEqual(parse(['<tool_call >\n{"name": "tool_search", "arguments": {"query": "x"}}\n</tool_call >']), want);
  assert.deepEqual(parse(['<toolcall>\n{"name": "tool_search", "arguments": {"query": "x"}}\n</toolcall>']), want);
});

test('a JSON example in prose is prose', () => {
  // `{"name": …}` with no arguments is not a call, and neither is a brace on its own: reading either as one
  // would run a tool the model never asked for.
  const prose = 'Use {"name": "tool_search"} as the shape.';
  assert.deepEqual(parse([prose]), [{ kind: 'text', text: prose }]);
  assert.deepEqual(parse(['Curly {']), [{ kind: 'text', text: 'Curly {' }]);
  assert.deepEqual(parse([]), []);
});

test('lenientCalls: false leaves a bare call as text, and a wrapped one alone', () => {
  const bare = '{"name": "tool_search", "arguments": {"query": "x"}}';
  assert.deepEqual(parse([bare], false), [{ kind: 'text', text: bare }]);
  assert.deepEqual(
    parse(['<tool_call>\n{"name": "tool_search", "arguments": {"query": "x"}}\n</tool_call>'], false),
    [{ kind: 'call', name: 'tool_search', arguments: { query: 'x' } }],
  );
});

test('an argument value holding braces and quotes does not end the call early', () => {
  assert.deepEqual(
    parse(['{"name": "http", "arguments": {"url": "https://x/y", "body": "a}b\\"c{"}}']),
    [{ kind: 'call', name: 'http', arguments: { url: 'https://x/y', body: 'a}b"c{' } }],
  );
});

test('prose is never lost or invented, at any chunking', () => {
  // The buffer is held back around markers; a brace in ordinary text must not be held for ever or dropped.
  const prose = 'No braces here, just words. And a colon: and a { brace.';
  assertAtEveryChunking(prose, [{ kind: 'text', text: prose }]);
});
