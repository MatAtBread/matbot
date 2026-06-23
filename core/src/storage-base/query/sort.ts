import type { SortSpec } from '@matatbread/matbot-plugin-api';
import { getField, pathSegments } from './access.js';

// Compares two resolved field values. Missing (undefined/null) sorts last; numbers compare
// numerically, everything else by string codepoint order.
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const am = a === undefined || a === null;
  const bm = b === undefined || b === null;
  if (am || bm) return am ? (bm ? 0 : 1) : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a), bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// Sorts by the requested specs, then appends `id` as a final tiebreaker so the order is always
// total — without which an opaque cursor over the result could not point at a stable boundary.
export function applySort<T extends { id: string }>(docs: T[], sort: SortSpec[] | undefined): T[] {
  const compiled = [...(sort ?? []), { field: 'id', dir: 'asc' as const }]
    .map(s => ({ seg: pathSegments(s.field), sign: s.dir === 'desc' ? -1 : 1 }));

  return [...docs].sort((a, b) => {
    for (const { seg, sign } of compiled) {
      const c = compareValues(getField(a, seg), getField(b, seg));
      if (c !== 0) return c * sign;
    }
    return 0;
  });
}
