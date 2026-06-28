import type { FieldPath } from '@matatbread/matbot-plugin-api';

export function pathSegments(field: FieldPath): string[] {
  return Array.isArray(field) ? field : [field];
}

// Null-safe traversal (the grammar's implicit `?.`): any absent or non-object segment
// short-circuits to undefined and never throws. A present `null` is returned as-is.
export function getField(row: unknown, segments: string[]): unknown {
  let cur: unknown = row;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
