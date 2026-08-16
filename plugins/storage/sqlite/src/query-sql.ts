import type { Filter, FieldPath, SortSpec, Comparable } from '@matatbread/matbot-plugin-api';

// The StoreQuery grammar compiled to real SQL, rather than loaded into memory and evaluated by the
// reference engine. The grammar exists to be translated, and this is the demonstration: each `op` is
// one `WHERE` fragment, the whole filter is one total `switch`, and the pushdown is exact — the
// SQLite backend answers the same question the in-memory backend does, checked by a shared
// conformance corpus (apps/cli/test/query-sql-conformance.test.ts).
//
// Documents are stored as JSON text, so a field reference becomes `json_extract(doc, <path>)` and
// its type becomes `json_type(doc, <path>)`. Two properties of that pair carry the whole translation:
//
//   - `json_type` returns NULL for an absent path and 'null' for a stored JSON null, which is exactly
//     the grammar's single "missing" state, and it distinguishes 'true'/'false' from 'integer' —
//     without which type-strictness would be unrepresentable, since `json_extract` erases a JSON
//     boolean to the integer 0/1 that a number would also produce.
//   - a path is BOUND, never interpolated, so there is no injection surface at all: the only strings
//     concatenated into SQL here are this file's own literals and the caller's table name (which the
//     store has already reduced to [A-Za-z0-9_]).

export type SqlParam = string | number;

export interface Sql {
  text:   string;
  params: SqlParam[];
}

// SQLite's JSON path quotes a key as a JSON string — backslash escapes, not doubled quotes — so
// `JSON.stringify` IS the escaper. Every segment is quoted unconditionally: `$."a"."b"` is valid for
// ordinary identifiers too, and an unquoted fast path would only add a second thing to get wrong for
// keys containing `.`, `[`, `"` or a control character.
//
// A numeric segment addresses the object key "0" (`$."0"`), never an array position — `[0]` is a
// different path syntax and the grammar has no positional accessor. The in-memory reference reaches
// an array element through one because JS indexing does not distinguish the two; `arrayContains` is
// the operator the grammar actually defines for looking inside an array.
function jsonPath(field: FieldPath): string {
  const segments = Array.isArray(field) ? field : [field];
  return '$' + segments.map(s => `.${JSON.stringify(s)}`).join('');
}

// Every leaf is forced to 0/1 before it can reach `and`/`or`/`not`. SQL's three-valued logic is the
// one place this translation could go quietly wrong: `json_type(doc, ?) = 'text'` is NULL (not false)
// for a missing field, and `NOT NULL` is NULL, so `{ op: 'not', clause: stringContains }` would drop
// exactly the rows the grammar says it keeps — a row missing the field matches a negated predicate.
// Comparing with `IS` and wrapping in `IFNULL` closes it at the source instead of at each combinator.
function leaf(text: string, ...params: SqlParam[]): Sql {
  return { text: `IFNULL(${text}, 0)`, params };
}

function present(doc: string, path: string): Sql {
  return { text: `COALESCE(json_type(${doc}, ?), 'null') <> 'null'`, params: [path] };
}

// Type-strict equality: the operand's JS type picks the SQL type guard, so a stored "1" never equals
// 1 and a stored true never equals 1. A boolean needs no value comparison at all — `json_type` has
// already spelt the value out as 'true' or 'false'.
function equals(doc: string, path: string, v: Comparable): Sql {
  if (typeof v === 'boolean') return leaf(`json_type(${doc}, ?) IS ?`, path, v ? 'true' : 'false');
  const guard = typeof v === 'number' ? `json_type(${doc}, ?) IN ('integer','real')` : `json_type(${doc}, ?) IS 'text'`;
  return leaf(`${guard} AND json_extract(${doc}, ?) = ?`, path, path, v);
}

// Ordering is defined only within a type, so the operand's type is a guard and not just a value: a
// cross-type comparison must not match, where SQL would happily order an integer before a string.
function compare(doc: string, path: string, op: string, v: string | number): Sql {
  const guard = typeof v === 'number' ? `json_type(${doc}, ?) IN ('integer','real')` : `json_type(${doc}, ?) IS 'text'`;
  return leaf(`${guard} AND json_extract(${doc}, ?) ${op} ?`, path, path, v);
}

function combine(parts: Sql[], joiner: string, empty: string): Sql {
  if (parts.length === 0) return { text: empty, params: [] };
  return {
    text:   `(${parts.map(p => p.text).join(joiner)})`,
    params: parts.flatMap(p => p.params),
  };
}

export function compileFilter(f: Filter, doc: string): Sql {
  switch (f.op) {
    case 'and': return combine(f.clauses.map(c => compileFilter(c, doc)), ' AND ', '1');
    case 'or':  return combine(f.clauses.map(c => compileFilter(c, doc)), ' OR ',  '0');
    case 'not': {
      const inner = compileFilter(f.clause, doc);
      return { text: `NOT (${inner.text})`, params: inner.params };
    }

    case 'eq':  return equals(doc, jsonPath(f.field), f.value);
    case 'neq': {
      // `neq` excludes missing rows: the grammar never matches a comparison against a missing value,
      // so "not equal" still requires the field to be there.
      const path = jsonPath(f.field);
      const same = equals(doc, path, f.value);
      return combine([present(doc, path), { text: `NOT ${same.text}`, params: same.params }], ' AND ', '1');
    }

    case 'lt':  return compare(doc, jsonPath(f.field), '<',  f.value);
    case 'lte': return compare(doc, jsonPath(f.field), '<=', f.value);
    case 'gt':  return compare(doc, jsonPath(f.field), '>',  f.value);
    case 'gte': return compare(doc, jsonPath(f.field), '>=', f.value);

    case 'in': {
      const path = jsonPath(f.field);
      return combine(f.value.map(v => equals(doc, path, v)), ' OR ', '0');
    }
    case 'nin': {
      const path = jsonPath(f.field);
      const any  = combine(f.value.map(v => equals(doc, path, v)), ' OR ', '0');
      return combine([present(doc, path), { text: `NOT ${any.text}`, params: any.params }], ' AND ', '1');
    }

    case 'exists': {
      const p = present(doc, jsonPath(f.field));
      return f.value ? p : { text: `NOT (${p.text})`, params: p.params };
    }

    case 'stringContains': {
      const path = jsonPath(f.field);
      // `instr` is case-sensitive and returns 1 for an empty needle, matching String.prototype.includes
      // on both counts. The text guard is what keeps it from matching inside a stringified number.
      return leaf(`json_type(${doc}, ?) IS 'text' AND instr(json_extract(${doc}, ?), ?) > 0`, path, path, f.value);
    }

    case 'arrayContains': {
      const path = jsonPath(f.field);
      const v    = f.value;
      // `json_each` expands the array into rows, so membership is an EXISTS — the same type-strict
      // equality as `eq`, applied to the element's own `type`/`value` columns. NULL-safety is not
      // needed inside EXISTS: a row whose comparison is NULL simply is not selected.
      //
      // Only the BOOLEAN branch's guard is load-bearing, and it is the reason all three are written
      // out: `json_each` reports a JSON `true` as value 1, so `je.value = 1` cannot tell `[true]`
      // from `[1]`. SQLite already refuses to equate a number with a string across storage classes,
      // which makes the other two guards redundant in fact — but stating type-strictness once per
      // branch keeps it a property of this code rather than of a comparison rule elsewhere.
      const element = typeof v === 'boolean'
        ? { text: `je.type = ?`, params: [v ? 'true' : 'false'] as SqlParam[] }
        : typeof v === 'number'
          ? { text: `je.type IN ('integer','real') AND je.value = ?`, params: [v] as SqlParam[] }
          : { text: `je.type IS 'text' AND je.value = ?`,             params: [v] as SqlParam[] };
      return {
        text:   `IFNULL(json_type(${doc}, ?) IS 'array', 0) AND EXISTS (SELECT 1 FROM json_each(${doc}, ?) AS je WHERE ${element.text})`,
        params: [path, path, ...element.params],
      };
    }
  }
}

// The sort spec compiled to ORDER BY, with `id` appended as the final tiebreaker so the order is
// total and a cursor points at a stable boundary.
//
// Each spec becomes TWO keys. The first segregates missing values, because SQL's NULL ordering is a
// property of the direction (NULLs last under DESC) where the grammar's is a property of the value
// (missing sorts last, so it sorts FIRST when the direction is reversed) — a plain `NULLS LAST`
// would silently disagree on every descending sort. The second is the value, with booleans spelt
// back out as text so they sort where the reference sorts them (`String(true)`) rather than as the
// integer 0/1 that `json_extract` would yield.
//
// One divergence remains, and only for a field holding MIXED types across documents: SQLite orders
// every number before every string (storage-class order), where the reference stringifies and
// compares "10" < "9". Within a type — the case a sort on a real field is — the two agree exactly,
// numerically for numbers and by binary/codepoint order for text.
export function compileOrderBy(sort: SortSpec[] | undefined, doc: string, id: string): Sql {
  const params: SqlParam[] = [];
  const keys: string[] = [];

  for (const spec of sort ?? []) {
    const path = jsonPath(spec.field);
    const dir  = spec.dir === 'desc' ? 'DESC' : 'ASC';
    keys.push(`CASE WHEN COALESCE(json_type(${doc}, ?), 'null') <> 'null' THEN 0 ELSE 1 END ${dir}`);
    params.push(path);
    keys.push(`CASE json_type(${doc}, ?) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_extract(${doc}, ?) END ${dir}`);
    params.push(path, path);
  }

  keys.push(`${id} ASC`);
  return { text: keys.join(', '), params };
}
