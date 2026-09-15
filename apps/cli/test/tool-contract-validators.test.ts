import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts } from '@matatbread/matbot-tool-types';

// A tool's `ToolContracts` arm is a real TypeScript type; its `inputSchema` is a projection of it, and a
// lossy one — per-arm `required`, bounds and cross-field rules do not survive the derivation, which is why
// tools re-check them by hand. These validators are emitted from the CHECKER'S RESOLVED TYPE in the same
// pass that builds the dts, so the type is what gets enforced rather than its projection.
//
// Two bugs are pinned here, both of which a green unit suite missed and only running against the real
// contracts found:
//   - an INTERSECTION arm (`{ action: 'query' } & Omit<StoreQuery, 'immutable'>`) carries `Intersection`,
//     not `Object`. Missing that arm refused four tools outright; missing it in the DISCRIMINANT test
//     silently degraded every failure on those tools to "no union member matched".
//   - the bare `object` type carries `NonPrimitive`, not `Object`, and refused two more.
// Both were whole-tool failures produced by one unhandled flag, so the coverage assertion below is the
// real guard: not "does it work" but "does it still cover everything".
const root = join(import.meta.dirname, '..', '..', '..');

test('every scanned contract yields a callable validator or a stated refusal', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built, 'expected the monorepo scan to produce a dts');

  const names = Object.keys(built.contracts);
  assert.ok(names.length > 20, `vacuity guard: expected the scan to reach many contracts, got ${names.length}`);

  // Every contract must produce an entry — a validator or an explicit refusal. A missing key means the
  // generator was never reached, which is the silent case.
  const missing = names.filter(n => built.validators[n] === undefined);
  assert.deepEqual(missing, [], 'every scanned contract must yield a validator or a stated refusal');

  // Nothing in this repo should currently be unvalidatable. If a contract legitimately becomes so (a
  // `bigint`, a branded primitive), this failure is the prompt to decide that deliberately rather than
  // discover a tool quietly stopped being checked.
  const refused = Object.entries(built.validators)
    .filter(([, v]) => 'refused' in v)
    .map(([n, v]) => `${n}: ${(v as { refused: string }).refused}`);
  assert.deepEqual(refused, [], 'no contract in this repo should be unvalidatable');

  // Each entry must carry a callable validator, not merely have been produced. (Generation compiles
  // eagerly, so a syntactically broken emit would already have thrown inside the build.)
  for (const [name, v] of Object.entries(built.validators)) {
    if ('refused' in v) continue;
    assert.equal(typeof v.validate, 'function', `${name}: must expose a callable validator`);
    assert.doesNotThrow(() => v.validate({}), `${name}: validating a value must not throw`);
  }
});

test('a multi-action tool dispatches on its discriminant and reports against that arm', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built);
  const entry = built.validators['session_action'];
  assert.ok(entry && !('refused' in entry), 'session_action must be validatable');
  const { validate } = entry;

  assert.deepEqual(validate({ action: 'list' }), [], 'a valid call with only its discriminant');
  assert.deepEqual(validate({ action: 'get', sessionId: 's1' }), [], 'a valid call with its required field');
  // `query` is `{ action: 'query' } & Omit<StoreQuery, 'immutable'>` — the intersection arm.
  assert.deepEqual(validate({ action: 'query' }), [], 'an intersection arm with everything optional');

  // An unknown action names the alternatives, rather than saying nothing matched.
  const unknown = validate({ action: 'nope' });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.path, '.action');
  assert.match(unknown[0]?.message ?? '', /expected one of/, 'the discriminant error must enumerate the arms');

  // A missing field is reported at ITS path against the arm the caller selected — this is what dispatch
  // buys, and what "no union member matched" costs.
  const missing = validate({ action: 'rename', sessionId: 's' });
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.path, '.title');
  assert.match(missing[0]?.message ?? '', /required property missing/);

  const wrongType = validate({ action: 'list', includeArchived: 'yes' });
  assert.equal(wrongType[0]?.path, '.includeArchived');
  assert.match(wrongType[0]?.message ?? '', /expected boolean/);

  // The type is enforced, not the schema: `inputSchema` for a multi-action tool requires only `action`.
  assert.ok(validate({ action: 'get' }).length, 'a per-arm requirement the schema drops is still enforced');
});

test('an unknown property is rejected, at its own path', async () => {
  // Excess properties are rejected, as TypeScript rejects them on a fresh object literal — which is what
  // a model-authored params object is. Otherwise the commonest tool-call hallucination, an invented or
  // misspelled key, fails SILENTLY: it is dropped, and the tool runs believing it was not passed
  // (`sessionId` mis-sent as `session_id` reads as "no session given" rather than as a typo).
  const built = await buildMatbotToolsDts(root);
  assert.ok(built);

  const session = built.validators['session_action'];
  assert.ok(session && !('refused' in session));
  // Reported against the arm the discriminant selected, so the message can name the right field set.
  const bogus = session.validate({ action: 'get', sessionId: 's1', session_id: 's1' });
  assert.equal(bogus.length, 1, `expected exactly the excess key, got ${JSON.stringify(bogus)}`);
  assert.equal(bogus[0]?.path, '.session_id');
  assert.match(bogus[0]?.message ?? '', /unexpected property/);

  // The discriminant itself is a declared property of its arm, so dispatching on it must not then flag
  // it as excess.
  assert.deepEqual(session.validate({ action: 'list' }), [], 'the discriminant is not an excess key');

  // An intersection arm's properties come from BOTH sides (`{ action: 'query' } & Omit<StoreQuery, …>`).
  // Taking `known` from one side would flag every field of the other as unexpected.
  assert.deepEqual(session.validate({ action: 'query', limit: 5 }), [], 'a merged-in field is known');

  // `NoParams` reaches the same answer by a different route — `Record<string, never>` is an index
  // signature, so every key fails as `never` rather than as excess. Pinned because it is why a closed
  // contract was, before this, the LOOSER of the two.
  // With NO discriminant the arms are tried blind, and each fails for its own reason — so a key that no
  // arm declares must be named up front. `background` has no `action`; sent `every_action`'s call shape
  // it used to report `.prompt` missing, which points at the arguments rather than the wrong tool.
  const background = built.validators['background'];
  assert.ok(background && !('refused' in background));
  const wrongTool = background.validate({ action: 'cancel', id: 'x' });
  assert.deepEqual(wrongTool.map(e => `${e.path}: ${e.message}`), ['.action: unexpected property', '.id: unexpected property']);
  assert.deepEqual(background.validate({ prompt: 'p', interval: '5m' }), [], 'a key declared by only one arm is not excess');

  const about = built.validators['about_matbot'];
  assert.ok(about && !('refused' in about));
  assert.deepEqual(about.validate({}), [], 'no arguments is the valid call');
  assert.equal(about.validate({ X: 1 }).length, 1, 'NoParams admits no properties at all');
});

test('a validator that accepts more than it appears to says so', async () => {
  const built = await buildMatbotToolsDts(root);
  assert.ok(built);
  // `trigger_action`'s `params` is a bare `object` and `provider`'s `parameters` an index of `unknown`:
  // both real, deliberately-open contracts. They must be reported as caveats rather than refused, so an
  // unenforced field is visible instead of looking checked.
  const caveats = Object.entries(built.validators).flatMap(([name, v]) =>
    'refused' in v ? [] : v.warnings.map(w => `${name} ${w}`));
  assert.ok(
    caveats.some(c => c.startsWith('trigger_action') && c.includes('`object`')),
    `expected a bare-object caveat for trigger_action, got: ${caveats.join(' | ') || '(none)'}`,
  );
});
