import type { SortSpec } from '@matbot/core';
import { getNestedField } from './filter.js';

export function applySort<T>(docs: T[], sort: SortSpec<T>[]): T[] {
  return [...docs].sort((a, b) => {
    for (const spec of sort) {
      const field = spec.field as string;
      if (field === '_score' || field === '_recency') continue;

      const av = getNestedField(a, field);
      const bv = getNestedField(b, field);

      let cmp: number;
      if (av === bv)                                           cmp = 0;
      else if (av === undefined || av === null)                cmp = 1;
      else if (bv === undefined || bv === null)                cmp = -1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else                                                     cmp = String(av) < String(bv) ? -1 : 1;

      if (cmp !== 0) return spec.direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}
