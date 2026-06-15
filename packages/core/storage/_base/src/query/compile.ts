import type { Filter, Orderable } from '@matatbread/matbot-core';
import { getField, pathSegments } from './access.js';

type Predicate = (row: unknown) => boolean;

// null and absent collapse to a single "missing" state — no comparison ever matches a missing
// value (so `neq` excludes missing rows too). Only `exists` observes missing-ness.
function resolve(row: unknown, seg: string[]): unknown {
  const v = getField(row, seg);
  return v === null ? undefined : v;
}

// Ordering is defined only within a type (numeric for numbers, codepoint for strings). A
// cross-type comparison yields undefined → the predicate is false (type-mismatch no-match).
function order(a: unknown, b: Orderable): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

// Compile the AST to a composed closure — the same one-pass "compile to native" the SQL/ES
// backends do, with JS closures as the target. No `eval`/`new Function`: CSP-safe, and operands
// are captured as data so there is no injection surface.
export function compileFilter(f: Filter): Predicate {
  switch (f.op) {
    case 'and': { const ps = f.clauses.map(compileFilter); return r => ps.every(p => p(r)); }
    case 'or':  { const ps = f.clauses.map(compileFilter); return r => ps.some(p => p(r)); }
    case 'not': { const p = compileFilter(f.clause); return r => !p(r); }

    case 'eq':  { const seg = pathSegments(f.field), v = f.value; return r => resolve(r, seg) === v; }
    case 'neq': { const seg = pathSegments(f.field), v = f.value; return r => { const x = resolve(r, seg); return x !== undefined && x !== v; }; }
    case 'lt':  { const seg = pathSegments(f.field), v = f.value; return r => { const c = order(resolve(r, seg), v); return c !== undefined && c < 0; }; }
    case 'lte': { const seg = pathSegments(f.field), v = f.value; return r => { const c = order(resolve(r, seg), v); return c !== undefined && c <= 0; }; }
    case 'gt':  { const seg = pathSegments(f.field), v = f.value; return r => { const c = order(resolve(r, seg), v); return c !== undefined && c > 0; }; }
    case 'gte': { const seg = pathSegments(f.field), v = f.value; return r => { const c = order(resolve(r, seg), v); return c !== undefined && c >= 0; }; }
    case 'in':  { const seg = pathSegments(f.field), vs = f.value as unknown[]; return r => { const x = resolve(r, seg); return x !== undefined && vs.includes(x); }; }
    case 'nin': { const seg = pathSegments(f.field), vs = f.value as unknown[]; return r => { const x = resolve(r, seg); return x !== undefined && !vs.includes(x); }; }
    case 'exists':         { const seg = pathSegments(f.field), want = f.value; return r => (resolve(r, seg) !== undefined) === want; }
    case 'stringContains': { const seg = pathSegments(f.field), v = f.value; return r => { const x = resolve(r, seg); return typeof x === 'string' && x.includes(v); }; }
    case 'arrayContains':  { const seg = pathSegments(f.field), v = f.value; return r => { const x = getField(r, seg); return Array.isArray(x) && (x as unknown[]).includes(v); }; }
  }
}
