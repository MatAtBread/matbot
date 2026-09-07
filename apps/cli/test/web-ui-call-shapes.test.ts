import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts } from '@matatbread/matbot-tool-types';

// The web UI is a TYPELESS caller of typed contracts: `static/app.js` posts hand-written object
// literals to `POST /tools/:name`, and no compiler has ever checked them against the `ToolContracts`
// arm the tool declares. That was survivable while the params type was unenforced — a wrong key was
// dropped and a wrong type reached the executor's own checks. Now that the type IS enforced at the
// executor, any such divergence is a 422 on a button click.
//
// So these are the shapes app.js actually sends, transcribed from its `callTool` sites, asserted
// against the validators generated from the contracts. It found one real bug on its first run:
// `trigger_action update` accepts `cooldown: null` to clear the stored limits — the executor has
// always honoured it and the UI has always sent it — but the arm declared `cooldown?: TriggerCooldown`,
// so the documented call was untypeable. Enforcement is what made that visible.
//
// Transcribed rather than extracted because app.js spreads conditionals into several of these
// (`...(cooldown ? { cooldown } : {})`), so the literal in the source is not the shape on the wire.
// When a call site changes, change it here too; a divergence is the thing being tested.
const CALLS: [string, unknown][] = [
  ['about_matbot',     {}],
  ['session_action',   { action: 'list' }],
  ['session_action',   { action: 'get', sessionId: 's' }],
  ['session_action',   { action: 'rename', sessionId: 's', title: 't' }],
  ['session_action',   { action: 'hide', sessionId: 's' }],
  ['session_edit',     { action: 'fork', sessionId: 's', msgIndex: 0 }],
  ['session_edit',     { action: 'cut', sessionId: 's', msgIndex: 0 }],
  ['session_edit',     { action: 'split', sessionId: 's', msgIndex: 0 }],
  ['session_edit',     { action: 'compact', sessionId: 's', msgIndex: 0 }],
  ['session_edit',     { action: 'summarise', sessionId: 's', msgIndex: 0, provider: 'p' }],
  ['share',            { action: 'owner', namespace: 'sessions', id: '*' }],
  ['share',            { action: 'unshare', namespace: 'sessions', id: 'x', target: 'p' }],
  ['share',            { namespace: 'files', id: 'n', target: 'p' }],
  ['provider',         { action: 'list' }],
  ['profile_action',   { action: 'list' }],
  ['plugin',           { action: 'list' }],
  ['plugin',           { action: 'discover_local' }],
  ['workspace_action', { action: 'list' }],
  ['workspace_action', { action: 'delete', name: 'f' }],
  ['workspace_action', { action: 'write', name: 'f', content: 'x', encoding: 'base64' }],
  ['skill_action',     { action: 'list' }],
  ['skill_action',     { action: 'load', name: 'n' }],
  ['skill_action',     { action: 'metadata', name: 'n' }],
  ['skill_action',     { action: 'hide', name: 'n' }],
  ['skill_action',     { action: 'unhide', name: 'n' }],
  ['skill_action',     { action: 'delete', name: 'n' }],
  ['skill_action',     { action: 'save', name: 'n', content: 'c', catalogue: true }],
  ['trigger_action',   { action: 'list' }],
  ['trigger_action',   { action: 'remove', id: 'i' }],
  ['trigger_action',   { action: 'disable', id: 'i' }],
  ['trigger_action',   { action: 'enable', id: 'i' }],
  ['trigger_action',   { action: 'query', tool: 't' }],
  ['trigger_action',   { action: 'query', tool: 'skill_action', params: { action: 'use', name: 'n' } }],
  // `readCooldown` yields an object or null; both reach the wire, and null is how the UI clears.
  ['trigger_action',   { action: 'update', id: 'i', conditions: [], cooldown: null }],
  ['trigger_action',   { action: 'update', id: 'i', conditions: [], tool: 't', enabled: true, cooldown: { maxPerTurn: 1 }, params: {} }],
  ['trigger_action',   { action: 'add', conditions: [], tool: 'skill_action', params: { action: 'use', name: 'n' }, cooldown: { quietTurns: 0 } }],
  ['trigger_action',   { action: 'add', conditions: [], tool: 't', enabled: true, params: {} }],
];

test('every shape the web UI posts validates against its tool contract', async () => {
  const built = await buildMatbotToolsDts(join(import.meta.dirname, '..', '..', '..'));
  assert.ok(built, 'expected the monorepo scan to produce a dts');

  const bad: string[] = [];
  for (const [name, input] of CALLS) {
    const v = built.validators[name];
    // A missing validator is not a pass: the UI calls tools from several plugins, and a contract that
    // stopped being scanned would silently take every shape below with it.
    if (v === undefined) { bad.push(`${name}: no validator (contract not scanned?)`); continue; }
    if ('refused' in v) { bad.push(`${name}: contract refused — ${v.refused}`); continue; }
    const errs = v.validate(input);
    if (errs.length) bad.push(`${name} ${JSON.stringify(input)}\n    → ${errs.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }
  assert.deepEqual(bad, [], `the UI posts ${bad.length} shape(s) its contract rejects:\n  ${bad.join('\n  ')}`);
});

test('clearing a cool-down is an update-only affordance', async () => {
  // The asymmetry is deliberate and worth pinning, since `null` was just added to one arm: `update`
  // takes it because there is a stored limit to clear, `add` does not because there is not. Were the
  // arms unified, `add: { cooldown: null }` would typecheck and then be refused by the executor.
  const built = await buildMatbotToolsDts(join(import.meta.dirname, '..', '..', '..'));
  assert.ok(built);
  const v = built.validators['trigger_action'];
  assert.ok(v && !('refused' in v));

  assert.deepEqual(v.validate({ action: 'update', id: 'i', cooldown: null }), [], 'update clears with null');
  const added = v.validate({ action: 'add', conditions: [], tool: 't', cooldown: null });
  assert.equal(added.length, 1, 'add must not accept a null cool-down');
  assert.equal(added[0]?.path, '.cooldown');
});
