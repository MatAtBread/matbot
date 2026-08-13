import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, usageByProvider } from '@matatbread/matbot-core';
import type { Message, Usage } from '@matatbread/matbot-core';

// An adapter normalises for COMPARABILITY — every protocol has input and output tokens, and something
// must be common or a turn spanning three providers cannot be totalled at all. It retains for FIDELITY:
// the endpoint's own figures ride alongside, so the normalisation can be checked, reversed, or
// reconciled against a vendor's dashboard. The two only conflict if you keep one and not the other.

test('a normalised figure that reinterprets the endpoint keeps its components', () => {
  // What openai-compat emits for DeepSeek: prompt_tokens includes the cache hit, so inputTokens is
  // reported net of it (matching anthropic's input_tokens) — destructive on its own, since the vendor's
  // own dashboard says 89.
  const u: Usage = {
    inputTokens: 64, outputTokens: 11, cacheReadTokens: 25,
    reported: {
      prompt_tokens: 89, completion_tokens: 11, total_tokens: 100,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 9 },
      prompt_cache_hit_tokens: 25, prompt_cache_miss_tokens: 64,
    },
  };

  assert.equal(u.inputTokens + (u.cacheReadTokens ?? 0), u.reported!['prompt_tokens'],
    'the subtraction is reversible, so the vendor figure is recoverable');
  assert.deepEqual(u.reported!['completion_tokens_details'], { reasoning_tokens: 9 },
    'and the reasoning split survives being folded into outputTokens');
});

test('an explicit zero is not an absent field', () => {
  const said    = addUsage(undefined, { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 });
  const saidNot = addUsage(undefined, { inputTokens: 5, outputTokens: 1 });

  assert.equal(said.cacheReadTokens, 0, 'the endpoint told us there was no cache activity');
  assert.equal(saidNot.cacheReadTokens, undefined, 'this endpoint told us nothing at all');
  assert.notDeepEqual(said, saidNot,
    'collapsing these makes a host that strips the capability look like a call with no cache hit');
});

test('folding sums reported numerics and leaves the rest alone', () => {
  const a: Usage = { inputTokens: 10, outputTokens: 2,
    reported: { prompt_tokens: 10, service_tier: 'standard', latency: { first_token_ms: 120 } } };
  const b: Usage = { inputTokens: 20, outputTokens: 3,
    reported: { prompt_tokens: 20, service_tier: 'standard', latency: { first_token_ms: 80 } } };

  const sum = addUsage(a, b);
  assert.equal(sum.reported!['prompt_tokens'], 30);
  assert.equal(sum.reported!['service_tier'], 'standard', 'not summed, not mangled');
  assert.deepEqual(sum.reported!['latency'], { first_token_ms: 80 },
    'a summed latency object would be nonsense; per-call facts are read off the entries');
});

test('a mixed-provider turn totals on the normalised counters, never across reported keys', () => {
  // `prompt_tokens` (includes cache hits) and `input_tokens` (excludes cache reads) are the same key
  // name for different quantities, so they must never meet in one sum.
  const messages: Message[] = [{
    id: 'm1', role: 'user', content: [], createdAt: new Date(0).toISOString(), traceId: 't1',
    activity: [
      { kind: 'call', provider: 'deepseek', traceId: 't1', usage: { inputTokens: 64, outputTokens: 11,
        reported: { prompt_tokens: 89 } } },
      { kind: 'call', provider: 'claude',   traceId: 't1', usage: { inputTokens: 89, outputTokens: 13,
        reported: { input_tokens: 89 } } },
    ],
  }];

  const byProvider = usageByProvider(messages);
  assert.deepEqual([...byProvider.keys()].sort(), ['claude', 'deepseek']);
  assert.equal(byProvider.get('deepseek')!.reported!['prompt_tokens'], 89);
  assert.equal(byProvider.get('claude')!.reported!['input_tokens'], 89);
  assert.equal(byProvider.get('claude')!.reported!['prompt_tokens'], undefined,
    'the two vocabularies never merge');

  const totalIn = [...byProvider.values()].reduce((n, u) => n + u.inputTokens, 0);
  assert.equal(totalIn, 153, 'the normalised counters are what a cross-provider total is built from');
});
