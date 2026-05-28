import type { FilterExpr, Scalar } from '@matatbread/matbot-core';

export function getNestedField(doc: unknown, fieldPath: string): unknown {
  let current: unknown = doc;
  for (const part of fieldPath.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareScalars(a: unknown, b: Scalar): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

export function matchFilter<T>(doc: T, expr: FilterExpr): boolean {
  if ('and' in expr) return expr.and.every(e => matchFilter(doc, e));
  if ('or'  in expr) return expr.or.some(e => matchFilter(doc, e));
  if ('not' in expr) return !matchFilter(doc, expr.not);

  const val = getNestedField(doc, expr.field);

  switch (expr.op) {
    case 'eq':       return val === expr.value;
    case 'neq':      return val !== expr.value;
    case 'gt':       return compareScalars(val, expr.value) > 0;
    case 'gte':      return compareScalars(val, expr.value) >= 0;
    case 'lt':       return compareScalars(val, expr.value) < 0;
    case 'lte':      return compareScalars(val, expr.value) <= 0;
    case 'in':       return expr.value.includes(val as Scalar);
    case 'exists':   return val !== undefined && val !== null;
    case 'contains':
      if (typeof val === 'string') return val.includes(expr.value);
      if (Array.isArray(val))      return (val as unknown[]).includes(expr.value);
      return false;
    case 'range': {
      const cmpGte = expr.gte !== undefined ? compareScalars(val, expr.gte) : 1;
      const cmpLte = expr.lte !== undefined ? compareScalars(val, expr.lte) : -1;
      return cmpGte >= 0 && cmpLte <= 0;
    }
  }
}
