// The TypeScript type of a JSON value, as text: what a body reading an entry is checked against, and what
// the model is shown beside it. It is spliced into a type-check verbatim, so it must be valid TypeScript
// whatever it is given, and anything it cannot describe compactly is `unknown` — which a reader must narrow,
// rather than a guess it could rely on wrongly.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 8;
const MAX_UNION = 4;
const MAX_KEYS  = 40;
const MAX_TEXT  = 4000;

const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function union(shapes: readonly string[]): string {
  const distinct = [...new Set(shapes)];
  return distinct.length > MAX_UNION ? 'unknown' : distinct.join(' | ');
}

// `{}` is not the empty object type (it is "any non-nullish value"), so an empty object is spelt out.
function objectType(fields: readonly string[]): string {
  return fields.length === 0 ? 'Record<string, never>' : `{ ${fields.join('; ')} }`;
}

// An array of objects is one object type, a key absent from some elements optional: the shape of a table,
// which is what a query hands back. Typed per element it would be a union as long as the table.
function rows(items: readonly Record<string, unknown>[], depth: number): string {
  const seen = new Map<string, string[]>();
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      const shapes = seen.get(k) ?? [];
      shapes.push(shapeAt(v, depth + 1));
      seen.set(k, shapes);
    }
  }
  if (seen.size > MAX_KEYS) return 'Record<string, unknown>';
  return objectType([...seen].map(([k, shapes]) => `${key(k)}${shapes.length < items.length ? '?' : ''}: ${union(shapes)}`));
}

function shapeAt(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return 'unknown';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': case 'number': case 'boolean': return typeof value;
    default: break;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'unknown[]';
    if (value.every(isRecord)) return `${rows(value, depth)}[]`;
    const element = union(value.map(v => shapeAt(v, depth + 1)));
    return element.includes(' | ') ? `(${element})[]` : `${element}[]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_KEYS) return 'Record<string, unknown>';
    return objectType(entries.map(([k, v]) => `${key(k)}: ${shapeAt(v, depth + 1)}`));
  }
  return 'unknown';
}

/** The type of `value`, which is JSON (it has been through `JSON.parse`). */
export function shapeOf(value: unknown): string {
  const text = shapeAt(value, 0);
  return text.length <= MAX_TEXT ? text : (Array.isArray(value) ? 'unknown[]' : 'unknown');
}
