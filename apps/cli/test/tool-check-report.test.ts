import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToolCheck } from '../../../plugin-api/src/index.ts';
import type { ToolCheckDiagnostic, ToolCheckReport } from '../../../plugin-api/src/index.ts';

const d = (label: string, syn?: true): ToolCheckDiagnostic => ({
  label, code: syn === true ? 90003 : 2339, message: 'm', rendered: `line 1 ${label}: m`,
  ...(syn === true ? { syn } : {}),
});

test('the overflow summary is data, never an element of the findings', () => {
  // It used to be appended to the array, so `diagnostics.length` counted a prose line as a finding —
  // 9 reported for a function with 10 — and any per-code breakdown taken by iterating was unreliable.
  const report: ToolCheckReport = {
    ok: false, total: 10,
    diagnostics: [d('TS2339'), d('TS2339')],
    omitted: { count: 8, byLabel: { 'TS2352': 5, 'CAST-GATE': 3 } },
  };
  assert.equal(report.diagnostics.length, 2, 'the array holds findings and nothing else');
  assert.equal(report.total, 10, 'the count is stated, not inferred from the array');
  assert.ok(report.diagnostics.every(x => typeof x.code === 'number'));

  const text = renderToolCheck(report);
  assert.ok(text.endsWith('…plus 8 more: TS2352×5, CAST-GATE×3 — likely cascading from the errors above.'),
            `the summary is a trailing LINE of the rendering: ${text}`);
});

test('a cast-gate finding keeps its label in the overflow tally', () => {
  // The detail renderer honoured `syn`; the summary did not, so the same rule was CAST-GATE in the
  // first eight slots and TS90003 from the ninth — a code tsc has no error for at all.
  const text = renderToolCheck({
    ok: false, total: 9, diagnostics: [d('CAST-GATE', true)],
    omitted: { count: 8, byLabel: { 'CAST-GATE': 8 } },
  });
  assert.ok(text.includes('CAST-GATE×8'), text);
  assert.ok(!text.includes('TS90003'), 'the private code must never surface as a label');
});

test('the cascade advice is dropped when every hidden finding is structural', () => {
  // A cast-gate finding fires at one site and cascades from nothing; telling a reader to expect it to
  // vanish with the first fix is what would get it ignored.
  const structural = renderToolCheck({
    ok: false, total: 9, diagnostics: [d('CAST-GATE', true)],
    omitted: { count: 8, byLabel: { 'CAST-GATE': 8 } },
  });
  assert.ok(!structural.includes('cascading'), structural);

  const mixed = renderToolCheck({
    ok: false, total: 9, diagnostics: [d('TS2339')],
    omitted: { count: 8, byLabel: { 'CAST-GATE': 4, 'TS2352': 4 } },
  });
  assert.ok(mixed.includes('cascading'), mixed);
});

test('a clean report renders as nothing', () => {
  assert.equal(renderToolCheck({ ok: true, total: 0, diagnostics: [] }), '');
});
