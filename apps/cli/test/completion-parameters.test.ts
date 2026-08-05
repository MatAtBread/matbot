import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleTurnRequest } from '@matatbread/matbot-core';
import type { CompletionRequest, SingleTurnRequest, ProviderConfig } from '@matatbread/matbot-core';

// 0.4.0 removed CompletionRequest.parameters / SingleTurnRequest.parameters as deprecated surface, on the
// evidence that no caller in this repo set them. No caller in *this* repo is not no caller, and it broke a
// downstream consumer. The field is the only way to poke one call's transient behaviour (classify at a lower
// temperature, thinking off for a cheap sub-call) without minting a whole provider profile in global config
// that differs from its sibling in one field. These tests pin both halves so the argument has to be made
// against a failing test next time, not against a grep.

test('singleTurn forwards parameters through to the CompletionRequest', () => {
  const req: SingleTurnRequest = {
    provider:   'classifier',
    prompt:     'yes or no?',
    parameters: { temperature: 0, maxTokens: 4 },
  };
  const completion = singleTurnRequest(req);
  assert.deepEqual(completion.parameters, { temperature: 0, maxTokens: 4 });
});

test('an absent parameters stays absent rather than becoming undefined', () => {
  // exactOptionalPropertyTypes: a conditional spread, not `parameters: req.parameters`. An explicit
  // `parameters: undefined` would override a profile's own parameters with nothing at the merge below.
  const completion = singleTurnRequest({ provider: 'p', prompt: 'hi' });
  assert.equal('parameters' in completion, false);
});

// The merge both hosts perform (apps/cli/src/index.ts, apps/web-bundle/src/bootstrap.ts) before handing the
// config to an adapter. Spelled out here rather than imported because it lives inline in each host's
// complete(); if that ever becomes a shared helper, point this at it instead.
function hostMerge(profile: ProviderConfig, req: Pick<CompletionRequest, 'parameters'>): ProviderConfig {
  return {
    ...profile,
    ...(req.parameters !== undefined ? { parameters: { ...profile.parameters, ...req.parameters } } : {}),
  };
}

test('per-call parameters shallow-merge over the profile, request winning per key', () => {
  const profile: ProviderConfig = {
    module:     '@matatbread/matbot-provider-anthropic',
    model:      'claude-sonnet-4-6',
    parameters: { maxTokens: 4096, temperature: 1, thinking: { type: 'enabled', budget_tokens: 2048 } },
  };

  const merged = hostMerge(profile, { parameters: { temperature: 0 } });
  assert.equal(merged.parameters?.temperature, 0, 'the request wins on a key it names');
  assert.equal(merged.parameters?.maxTokens, 4096, 'a key it does not name survives from the profile');
  assert.deepEqual(merged.parameters?.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(merged.model, 'claude-sonnet-4-6', 'the rest of the profile is untouched');

  assert.deepEqual(hostMerge(profile, {}).parameters, profile.parameters, 'no override ⇒ profile verbatim');
});
