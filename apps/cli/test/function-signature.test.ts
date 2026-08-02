import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { parseSignature, buildAsyncFn, runFunction } from '@matatbread/matbot-function-tools';
import type { MatbotMachine, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

// Regression guard for comment-blind signature parsing. The scanners that locate a definition's
// parameter list and body tracked string literals but not comments, so an apostrophe in prose — a
// possessive, a contraction — opened a string that swallowed the rest of the source. The body was then
// unlocatable and `define` reported a missing RETURN TYPE, pointing the author at a line that was
// already correct. From the field report: the author bisected the body line by line and concluded the
// trigger was "colons and em-dashes", which parse fine; a single `'` is the whole cause, so the
// misdirection cost more than the failure.

const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };

// The exact definition from the field report, verbatim.
const REPORTED = "whoareyou(): { session: string; provider: string } {\n  // Resolve the session from the injected execution context, never by searching\n  // storage: on the first turn the current session may not be flushed yet, so a\n  // recency-based query could resolve to the wrong session and report another\n  // conversation's provider.\n  const sessionId = context.sessionId;\n  if (!sessionId) {\n    return { session: '', provider: 'unknown' };\n  }\n\n  const detail: any = await tool.session_action({ action: 'get', sessionId });\n  if (detail === null || typeof detail !== 'object' || !('messages' in detail)) {\n    return { session: sessionId, provider: 'unknown' };\n  }\n  const msgs: any[] = detail.messages;\n  if (!Array.isArray(msgs) || msgs.length === 0) {\n    return { session: sessionId, provider: 'unknown' };\n  }\n  const lastMsg = msgs[msgs.length - 1] as { providerName?: string };\n  const provider: string = lastMsg.providerName || 'unknown';\n  const title: string = typeof detail.title === 'string' && detail.title ? detail.title : sessionId;\n  return { session: title, provider };\n}";

test('the reported definition parses, with its object return type intact', () => {
  const sig = parseSignature(REPORTED);
  assert.equal(sig.name, 'whoareyou');
  assert.equal(sig.returnType, '{ session: string; provider: string }');
  assert.deepEqual(sig.params, []);
});

test('prose punctuation in a comment does not confuse the parser', () => {
  const bodies: Record<string, string> = {
    apostrophe:   `// another conversation's provider`,
    contraction:  `// don't do this`,
    block:        `/* the tool's rationale — spanning\n     two lines */`,
    braces:       `// returns { a: 1 }`,
    unclosedParen:`// see foo( for detail`,
    quote:        `// he said "no"`,
  };
  for (const [name, comment] of Object.entries(bodies)) {
    const sig = parseSignature(`f(): string {\n  ${comment}\n  return 'x';\n}`);
    assert.equal(sig.returnType, 'string', `${name}: return type lost`);
  }
});

test('a comment ahead of the definition is trivia, not a parse failure', async () => {
  const src = `// what this does\n/* and why */\nf(a: string): string { return a; }`;
  const sig = parseSignature(src);
  assert.equal(sig.name, 'f');
  assert.equal(sig.returnType, 'string');
  // It must also COMPILE: leading trivia would otherwise land between `function` and the name.
  const fn = await buildAsyncFn(stripper, src, ['a']);
  assert.equal(typeof fn, 'function');
});

test('a comment inside the parameter list stays out of the parsed type', () => {
  const sig = parseSignature(`f(a: string /* the city */, b?: number): string { return a; }`);
  assert.deepEqual(sig.params, [
    { name: 'a', optional: false, type: 'string' },
    { name: 'b', optional: true,  type: 'number' },
  ]);
});

test('an unlocatable body is reported as such, not as a missing return type', () => {
  assert.throws(() => parseSignature(`f(): string { return 'x';`), /could not find the function body/);
});

test('the reported definition also runs, resolving the session from the injected context', async () => {
  let sawSessionId: unknown;
  const machine = {
    tools: {
      resolve: (n: string) => n !== 'session_action' ? null : {
        executor: {
          async *execute(input: { sessionId?: string }) {
            sawSessionId = input.sessionId;
            yield { type: 'result', value: { title: 'My chat', messages: [{ providerName: 'a-model' }] } };
          },
        },
      },
    },
  } as unknown as MatbotMachine;
  const ctx = {
    callId: 'c1', session: { id: 'sess-abc' }, signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error('non-interactive')),
  } as unknown as ToolContext;

  const fn = await buildAsyncFn(stripper, REPORTED, []);
  const events: ToolEvent[] = [];
  for await (const ev of runFunction(machine, ctx, fn, [])) events.push(ev);

  assert.equal(sawSessionId, 'sess-abc');
  assert.deepEqual(events.at(-1), { type: 'result', value: { session: 'My chat', provider: 'a-model' } });
});

// A composition that returns nothing yields no `result` event. `undefined` is "no result", not "a
// result that is undefined": the triggers dispatcher fires only on a yielded result, so a composition
// used as a trigger's `invoke` could not stay silent while it always yielded one — which is the
// difference between an adjudicator that says nothing and one that wakes the model to say nothing.
test('a composition returning undefined yields no result event', async () => {
  const machine = { tools: { resolve: () => null } } as unknown as MatbotMachine;
  const ctx = {
    callId: 'c1', session: { id: 'sess-abc' }, signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error('non-interactive')),
  } as unknown as ToolContext;

  const silent = await buildAsyncFn(stripper, `f(): string | undefined { return undefined; }`, []);
  const events: ToolEvent[] = [];
  for await (const ev of runFunction(machine, ctx, silent, [])) events.push(ev);
  assert.deepEqual(events, []);

  const speaking = await buildAsyncFn(stripper, `f(): string | undefined { return 'said'; }`, []);
  const spoke: ToolEvent[] = [];
  for await (const ev of runFunction(machine, ctx, speaking, [])) spoke.push(ev);
  assert.deepEqual(spoke, [{ type: 'result', value: 'said' }]);
});
