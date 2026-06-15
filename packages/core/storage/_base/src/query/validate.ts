import type { StoreQuery, Filter } from '@matatbread/matbot-core';
import { StoreQueryError } from '@matatbread/matbot-core';

// Validate the query at the boundary, before any backend touches data, and throw a located,
// detailed StoreQueryError so an LLM author can fix the offending clause and retry. Input is
// treated as untrusted (LLM/JSON-sourced) — the static types are only a convenience for callers.

function isComparable(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function requireComparable(v: unknown, ptr: string, op: string): void {
  if (v === null)
    throw new StoreQueryError(`'${op}' cannot compare to null — use { op: 'exists', value: false } to match absent-or-null`, ptr, 'NULL_OPERAND');
  if (!isComparable(v))
    throw new StoreQueryError(`'${op}' requires a string|number|boolean value`, ptr, 'OPERAND_TYPE');
}

function requireOrderable(v: unknown, ptr: string, op: string): void {
  if (v === null)
    throw new StoreQueryError(`'${op}' cannot compare to null — use { op: 'exists', value: false }`, ptr, 'NULL_OPERAND');
  if (typeof v !== 'string' && typeof v !== 'number')
    throw new StoreQueryError(`'${op}' requires a string|number value`, ptr, 'OPERAND_TYPE');
}

function validateField(field: unknown, ptr: string): void {
  if (typeof field === 'string') {
    if (field.length === 0) throw new StoreQueryError('field path is empty', ptr, 'EMPTY_FIELD');
    return;
  }
  if (Array.isArray(field)) {
    if (field.length === 0) throw new StoreQueryError('field path has no segments', ptr, 'EMPTY_FIELD');
    field.forEach((s, i) => {
      if (typeof s !== 'string' || s.length === 0)
        throw new StoreQueryError('field path segment must be a non-empty string', `${ptr}/${i}`, 'EMPTY_FIELD');
    });
    return;
  }
  throw new StoreQueryError('field must be a string or array of strings', ptr, 'MALFORMED');
}

function validateFilter(f: Filter, ptr: string): void {
  if (f === null || typeof f !== 'object' || typeof (f as { op?: unknown }).op !== 'string')
    throw new StoreQueryError('filter node must be an object with an `op`', ptr, 'MALFORMED');

  switch (f.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(f.clauses) || f.clauses.length === 0)
        throw new StoreQueryError(`'${f.op}' requires a non-empty clauses array`, `${ptr}/clauses`, 'EMPTY_CLAUSES');
      f.clauses.forEach((c, i) => validateFilter(c, `${ptr}/clauses/${i}`));
      return;
    case 'not':
      if (f.clause === undefined)
        throw new StoreQueryError(`'not' requires a clause`, `${ptr}/clause`, 'MALFORMED');
      validateFilter(f.clause, `${ptr}/clause`);
      return;
    case 'eq':
    case 'neq':
      validateField(f.field, `${ptr}/field`);
      requireComparable(f.value, `${ptr}/value`, f.op);
      return;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      validateField(f.field, `${ptr}/field`);
      requireOrderable(f.value, `${ptr}/value`, f.op);
      return;
    case 'in':
    case 'nin':
      validateField(f.field, `${ptr}/field`);
      if (!Array.isArray(f.value))
        throw new StoreQueryError(`'${f.op}' requires an array value`, `${ptr}/value`, 'OPERAND_TYPE');
      f.value.forEach((el, i) => requireComparable(el, `${ptr}/value/${i}`, f.op));
      return;
    case 'exists':
      validateField(f.field, `${ptr}/field`);
      if (typeof f.value !== 'boolean')
        throw new StoreQueryError(`'exists' requires a boolean value`, `${ptr}/value`, 'OPERAND_TYPE');
      return;
    case 'stringContains':
      validateField(f.field, `${ptr}/field`);
      if (typeof f.value !== 'string')
        throw new StoreQueryError(`'stringContains' requires a string value`, `${ptr}/value`, 'OPERAND_TYPE');
      return;
    case 'arrayContains':
      validateField(f.field, `${ptr}/field`);
      requireComparable(f.value, `${ptr}/value`, f.op);
      return;
    default:
      throw new StoreQueryError(`unknown op '${String((f as { op: unknown }).op)}'`, `${ptr}/op`, 'UNKNOWN_OP');
  }
}

export function validateQuery(q: StoreQuery): void {
  if (q.where !== undefined) validateFilter(q.where, '/where');

  if (q.sort !== undefined) {
    if (!Array.isArray(q.sort))
      throw new StoreQueryError('`sort` must be an array', '/sort', 'MALFORMED');
    q.sort.forEach((s, i) => {
      if (s === null || typeof s !== 'object')
        throw new StoreQueryError('sort spec must be an object', `/sort/${i}`, 'MALFORMED');
      validateField(s.field, `/sort/${i}/field`);
      if (s.dir !== 'asc' && s.dir !== 'desc')
        throw new StoreQueryError(`sort dir must be 'asc' or 'desc'`, `/sort/${i}/dir`, 'MALFORMED');
    });
  }

  if (q.limit !== undefined && (typeof q.limit !== 'number' || !Number.isInteger(q.limit) || q.limit < 0))
    throw new StoreQueryError('`limit` must be a non-negative integer', '/limit', 'MALFORMED');
}
