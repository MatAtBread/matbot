import type TS from 'typescript';

// Emits a pure-JS validator for a tool's params type, from the CHECKER'S RESOLVED TYPE rather than
// from syntax. That distinction is the whole reason this is ~200 lines: conditionals, mapped types,
// generic instantiations, `Omit`/`Pick`/`Record`/`keyof` and indexed access all arrive already
// evaluated, so none of them is implemented here. Nothing in this file knows they exist.
//
// The target is the JSON PROJECTION of the type — what `JSON.stringify` actually puts on the wire —
// not the type as written. So a `Date` is validated as the string its `toJSON` returns; a class
// instance as its own enumerable data properties (methods live on the prototype and are dropped); a
// method or function-valued property as absent, because a payload can never carry one. The only
// refusal left is `bigint`, and it is refused because `JSON.stringify` itself throws on it.
//
// Refusals are DATA, never a throw at the seam: a contract this cannot honestly validate yields
// `{ refused }`, so the caller reports "no opinion" instead of a validator that silently passes.

export interface ValidationError {
  /** JSON Pointer into the value (`/where/0/op`); `/` for the root. */
  path:     string;
  message:  string;
  value?:   unknown;
}

export type Validator = (value: unknown) => ValidationError[];

/** A generated validator's source, or the reason none could be generated. */
export type ValidatorSource =
  | { src: string; warnings: string[] }
  | { refused: string };

/**
 * What a consumer wants: the callable validator, plus what it does NOT constrain.
 *
 * The emitted source is deliberately not handed out. Anyone who wants the text calls
 * {@link generateValidator}, which is the same generation this went through — so carrying a copy on
 * every entry would be a second way to obtain one thing. (Note `validate.toString()` is NOT that copy:
 * the helper functions live in the enclosing scope of `new Function`, so it recovers only the entry
 * stub, never the logic.)
 *
 * Compiling eagerly rather than lazily is deliberate: `new Function` compiles in the GLOBAL scope, so
 * the validator captures nothing — not the checker, not a `ts.Type`, not this module's locals — and the
 * `ts.Program` is collectable the moment the build returns either way. There is nothing to defer.
 */
export type ToolValidator =
  | { validate: Validator; warnings: string[] }
  | { refused: string };

/** Generate and compile in one step — {@link generateValidator} followed by {@link compileValidator}. */
export function buildToolValidator(
  ts: typeof TS, checker: TS.TypeChecker, root: TS.Type | readonly TS.Type[], location: TS.Node,
  opts: { excessProperties?: 'allow' | 'reject' } = {},
): ToolValidator {
  const out = generateValidator(ts, checker, root, location, opts);
  if ('refused' in out) return out;
  return { validate: compileValidator(out.src), warnings: out.warnings };
}

class Unsupported extends Error {
  readonly label: string;
  constructor(where: string, label: string) { super(`${where || '<root>'}: ${label}`); this.label = label; }
}

const PROTO_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

// Instances of these stringify to `{}` — all state sits behind prototype accessors or internal slots,
// so nothing reaches the wire. Validated as "some object", with a data-loss warning: the contract is
// expressible but says less than its author believes.
const EMPTY_JSON = new Set([
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'RegExp', 'Promise',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
]);

interface Check { expr: string; msg: string; reports: boolean }

/**
 * `root` is either a single type, or the ARM LIST of a multi-action tool — one params type per
 * `ToolContract` arm. They arrive separately (each is its own type argument) and TypeScript exposes no
 * way to construct a union type, so the list is unioned here instead, which also means a multi-action
 * tool gets ONE validator that dispatches on its discriminant.
 */
export function generateValidator(
  ts: typeof TS, checker: TS.TypeChecker, root: TS.Type | readonly TS.Type[], location: TS.Node,
  opts: { excessProperties?: 'allow' | 'reject' } = {},
): ValidatorSource {
  const F = ts.TypeFlags;
  const reject = opts.excessProperties === 'reject';
  const fns = new Map<TS.Type, string>();
  const bodies: (string | null)[] = [];
  const warnings: string[] = [];
  let n = 0;

  const lit = (v: unknown): string => JSON.stringify(v);
  const access = (v: string, k: string): string => /^[A-Za-z_$][\w$]*$/.test(k) ? `${v}.${k}` : `${v}[${lit(k)}]`;
  // Reported paths read as the ACCESS a caller would write — `.items[0].name`, not `/items/0/name` —
  // because the reader is a model repairing its own call, or a developer looking at a 422. Same rule as
  // `access` above, so a key needing brackets in code gets them in the diagnostic too.
  const propPath = (k: string): string => /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${lit(k)}]`;
  const typeOfProp = (s: TS.Symbol): TS.Type =>
    checker.getTypeOfSymbolAtLocation(s, s.valueDeclaration ?? location);

  function guard(t: TS.Type, where: string): void {
    if (t.getCallSignatures().length) throw new Unsupported(where, 'function type (not JSON-serializable)');
    // `JSON.stringify({ n: 1n })` throws `TypeError: Do not know how to serialize a BigInt`, so the
    // generator refusing here mirrors what the runtime would do anyway.
    if (t.flags & (F.BigInt | F.BigIntLiteral)) throw new Unsupported(where, 'bigint (JSON.stringify throws on it)');
    if (t.flags & (F.ESSymbol | F.UniqueESSymbol)) throw new Unsupported(where, 'symbol (not JSON-serializable)');
    // `string & { __brand }`. Without this it reaches the object walker, which refuses it only by
    // accident (a `string` carries a numeric index signature) and reports a misleading reason.
    const PRIM = F.String | F.Number | F.Boolean | F.StringLiteral | F.NumberLiteral | F.BooleanLiteral | F.BigInt | F.ESSymbol;
    if (t.isIntersection() && t.types.some(m => m.flags & PRIM)) {
      throw new Unsupported(where, 'intersection with a primitive (a brand is not checkable at runtime)');
    }
    if (t.flags & F.TypeParameter) throw new Unsupported(where, 'unresolved type parameter');
  }

  // `toJSON()` wins outright: a Date is a string on the wire, not an object with no fields. Applies to
  // any type declaring one, so a hand-written `toJSON(): { v, ccy }` is handled without a special case.
  function viaToJSON(t: TS.Type): TS.Type | undefined {
    if (!(t.flags & F.Object)) return undefined;
    const tj = checker.getPropertyOfType(t, 'toJSON');
    if (!tj) return undefined;
    const sigs = typeOfProp(tj).getCallSignatures();
    const first = sigs[0];
    if (!first) return undefined;
    const ret = checker.getReturnTypeOfSignature(first);
    return ret === t ? undefined : ret;
  }

  // Properties `JSON.stringify` never emits, so a payload cannot carry them and a validator must not
  // require them: methods, accessors (non-enumerable on a prototype), and any property whose value is
  // a function, undefined or a symbol.
  function isDropped(s: TS.Symbol, pt: TS.Type): boolean {
    const d = s.valueDeclaration ?? s.declarations?.[0];
    if (d && (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isGetAccessor(d) || ts.isSetAccessor(d))) return true;
    if (pt.getCallSignatures().length) return true;
    return (pt.flags & (F.Undefined | F.Void | F.ESSymbol | F.UniqueESSymbol)) !== 0;
  }

  function templateRegex(t: TS.TemplateLiteralType, where: string): string {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let src = '^';
    for (let i = 0; i < t.texts.length; i++) {
      src += esc(t.texts[i] ?? '');
      const inner = t.types[i];
      if (!inner) continue;
      if (inner.flags & F.String) src += '[\\s\\S]*';
      else if (inner.flags & F.Number) src += '-?\\d+(?:\\.\\d+)?';
      else if (inner.isStringLiteral()) src += esc(inner.value);
      else throw new Unsupported(where, 'template literal with an unsupported placeholder');
    }
    return `${src}$`;
  }

  function check(t: TS.Type, v: string, p: string, where: string): Check {
    const projected = viaToJSON(t);
    if (projected) return check(projected, v, p, `${where} (via toJSON)`);

    const sname = t.symbol?.name;
    if (sname !== undefined && EMPTY_JSON.has(sname) && !checker.isArrayType(t)) {
      warnings.push(`${where || '<root>'}: ${sname} stringifies to {} — no state reaches the wire`);
      return { expr: `(typeof ${v} === 'object' && ${v} !== null && !Array.isArray(${v}))`, msg: `expected object (${sname} carries no JSON state)`, reports: false };
    }
    guard(t, where);

    if (t.flags & (F.Any | F.Unknown)) {
      warnings.push(`${where || '<root>'}: ${t.flags & F.Any ? 'any' : 'unknown'} — accepts anything`);
      return { expr: 'true', msg: '', reports: false };
    }
    if (t.flags & F.Never)                 return { expr: 'false', msg: 'never (no value is valid)', reports: false };
    // The bare `object` type — `NonPrimitive`, not `Object`. It says only "not a primitive", so an
    // array satisfies it too. Warned about rather than refused: it is a real (if loose) contract, and
    // refusing would report a whole tool as unvalidatable over one deliberately-open field.
    if (t.flags & F.NonPrimitive) {
      warnings.push(`${where || '<root>'}: bare \`object\` — accepts any non-primitive`);
      return { expr: `(typeof ${v} === 'object' && ${v} !== null)`, msg: 'expected object', reports: false };
    }
    if (t.flags & F.Null)                  return { expr: `${v} === null`, msg: 'expected null', reports: false };
    if (t.flags & (F.Undefined | F.Void))  return { expr: `${v} === undefined`, msg: 'expected undefined', reports: false };
    if (t.isStringLiteral())               return { expr: `${v} === ${lit(t.value)}`, msg: `expected ${lit(t.value)}`, reports: false };
    if (t.isNumberLiteral())               return { expr: `${v} === ${t.value}`, msg: `expected ${t.value}`, reports: false };
    if (t.flags & F.BooleanLiteral) {
      const b = checker.typeToString(t) === 'true';
      return { expr: `${v} === ${b}`, msg: `expected ${b}`, reports: false };
    }
    if (t.flags & F.String)                return { expr: `typeof ${v} === 'string'`, msg: 'expected string', reports: false };
    // JSON carries neither NaN nor Infinity, so `Number.isFinite` is the honest check.
    if (t.flags & F.Number)                return { expr: `Number.isFinite(${v})`, msg: 'expected number', reports: false };
    if (t.flags & F.Boolean)               return { expr: `typeof ${v} === 'boolean'`, msg: 'expected boolean', reports: false };
    if (t.flags & F.TemplateLiteral) {
      const re = templateRegex(t as TS.TemplateLiteralType, where);
      return { expr: `(typeof ${v} === 'string' && /${re}/.test(${v}))`, msg: `expected string matching /${re}/`, reports: false };
    }
    return { expr: `${fnFor(t, where)}(${v}, ${p}, e)`, msg: '', reports: true };
  }

  function member(t: TS.Type, v: string, p: string, where: string, ind: string): string {
    const c = check(t, v, p, where);
    if (c.expr === 'true') return `${ind}/* ${where}: unconstrained */`;
    return c.reports
      ? `${ind}if (!(${c.expr})) ok = false;`
      : `${ind}if (!(${c.expr})) { E(${p}, ${lit(c.msg)}, ${v}, e); ok = false; }`;
  }

  // A property present in every arm with a distinct literal type: lets the union dispatch instead of
  // guess, so a failure is reported against the arm the caller MEANT rather than as "nothing matched".
  function discriminantOf(arms: readonly TS.Type[]): { name: string; vals: (string | number)[] } | undefined {
    // "object-like" must include Intersection, or a single `{ action: 'x' } & Omit<…>` arm defeats
    // discriminant dispatch for the WHOLE tool and every failure degrades to "no union member
    // matched" — which is exactly the error quality this dispatch exists to avoid.
    const objectLike = F.Object | F.Intersection;
    const first = arms[0];
    if (!first || !arms.every(a => a.flags & objectLike)) return undefined;
    for (const s0 of checker.getPropertiesOfType(first)) {
      const vals: (string | number)[] = [];
      let good = true;
      for (const arm of arms) {
        const s = checker.getPropertyOfType(arm, s0.name);
        if (!s || (s.flags & ts.SymbolFlags.Optional)) { good = false; break; }
        const pt = typeOfProp(s);
        if (pt.isStringLiteral() || pt.isNumberLiteral()) vals.push(pt.value);
        else { good = false; break; }
      }
      if (good && new Set(vals).size === arms.length) return { name: s0.name, vals };
    }
    return undefined;
  }

  function fnFor(t: TS.Type, where: string): string {
    const seen = fns.get(t);
    if (seen !== undefined) return seen;
    const name = `T${n++}`;
    fns.set(t, name);                    // BEFORE the body: this is what makes recursion terminate
    bodies.push(null);
    const slot = bodies.length - 1;
    bodies[slot] = `function ${name}(v, p, e) {\n${bodyOf(t, where)}\n}`;
    return name;
  }

  const OBJ_GUARD = `  if (typeof v !== 'object' || v === null || Array.isArray(v)) { E(p, 'expected object', v, e); return false; }\n`;

  // Shared by a real union type and by a multi-action tool's arm LIST (which is a union in the
  // contract but reaches us as separate `ToolContract` type arguments, with no API to union them).
  function unionBody(arms: readonly TS.Type[], where: string): string {
    const disc = discriminantOf(arms);
    if (disc) {
      const cases = arms.map((a, i) => `    case ${lit(disc.vals[i])}: return ${fnFor(a, `${where}(${lit(disc.vals[i])})`)}(v, p, e);`).join('\n');
      return `${OBJ_GUARD}  switch (${access('v', disc.name)}) {\n${cases}\n`
           + `    default: E(p + ${lit(propPath(disc.name))}, 'expected one of ${disc.vals.map(lit).join(', ')}', ${access('v', disc.name)}, e); return false;\n  }`;
    }
    // No discriminant: try each arm against a scratch buffer so a failed arm's errors don't leak.
    const attempts = arms.map((a, i) => {
      const c = check(a, 'v', 'p', `${where}|${i}`);
      return `  if (${c.reports ? c.expr.replace(/, e\)$/, ', scratch)') : c.expr}) return true;`;
    }).join('\n');
    return `${excessAcrossArms(arms)}  const scratch = [];\n${attempts}\n  E(p, 'no union member matched', v, e);\n  return false;`;
  }

  // A key no arm declares fails EVERY arm, so it can be reported by name before the arms are tried —
  // exact, not a guess at which arm was meant. Without it, a call that invents a key (an `action` on a
  // tool that has none) is reported as whatever else that arm lacks, which sends the caller to fix the
  // arguments it did pass instead of the key it should not have.
  function excessAcrossArms(arms: readonly TS.Type[]): string {
    const objectLike = F.Object | F.Intersection;
    if (!reject || !arms.every(a => (a.flags & objectLike) && !checker.getIndexInfoOfType(a, ts.IndexKind.String))) return '';
    const known = [...new Set(arms.flatMap(a => checker.getPropertiesOfType(a).map(s => s.name)))];
    return `  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {\n`
         + `    let excess = false;\n`
         + `    for (const k of Object.keys(v)) if (!${lit(known)}.includes(k)) { E(K(p, k), 'unexpected property', v[k], e); excess = true; }\n`
         + `    if (excess) return false;\n  }\n`;
  }

  function bodyOf(t: TS.Type, where: string): string {
    if (t.isUnion()) return unionBody(t.types, where);
    // An intersection carries `Intersection`, NOT `Object`, so it needs its own arm or it falls
    // through to the throw below — and `{ action: 'query' } & Omit<StoreQuery, 'immutable'>` is the
    // commonest real shape in this repo. `getPropertiesOfType` already merges the members.
    if (t.isIntersection()) return objectBody(t, where);
    if (checker.isArrayType(t)) {
      const el = checker.getTypeArguments(t as TS.TypeReference)[0];
      if (!el) throw new Unsupported(where, 'array with no element type');
      const c = check(el, 'x', `p + '[' + i + ']'`, `${where}[]`);
      const inner = c.expr === 'true' ? ''
        : c.reports ? `    if (!(${c.expr})) ok = false;\n`
        : `    if (!(${c.expr})) { E(p + '[' + i + ']', ${lit(c.msg)}, x, e); ok = false; }\n`;
      return `  if (!Array.isArray(v)) { E(p, 'expected array', v, e); return false; }\n  let ok = true;\n`
           + `  for (let i = 0; i < v.length; i++) { const x = v[i];\n${inner}  }\n  return ok;`;
    }

    if (checker.isTupleType(t)) {
      const els = checker.getTypeArguments(t as TS.TypeReference);
      const flags = (t as TS.TupleTypeReference).target.elementFlags;
      if (flags.some(f => f & ts.ElementFlags.Rest)) throw new Unsupported(where, 'rest element in a tuple');
      const min = els.filter((_, i) => (flags[i] ?? ts.ElementFlags.Required) & ts.ElementFlags.Required).length;
      const lines = els.map((el, i) => {
        const c = check(el, `v[${i}]`, `p + '[${i}]'`, `${where}[${i}]`);
        const one = c.reports ? `if (!(${c.expr})) ok = false;` : `if (!(${c.expr})) { E(p + '[${i}]', ${lit(c.msg)}, v[${i}], e); ok = false; }`;
        return ((flags[i] ?? 0) & ts.ElementFlags.Optional) ? `  if (v.length > ${i}) { ${one} }` : `  ${one}`;
      }).join('\n');
      const span = min === els.length ? `${els.length}` : `${min}..${els.length}`;
      return `  if (!Array.isArray(v)) { E(p, 'expected array', v, e); return false; }\n`
           + `  if (v.length < ${min} || v.length > ${els.length}) { E(p, 'expected ${span} elements', v.length, e); return false; }\n`
           + `  let ok = true;\n${lines}\n  return ok;`;
    }

    if (t.flags & F.Object) return objectBody(t, where);
    throw new Unsupported(where, `unhandled type ${checker.typeToString(t)}`);
  }

  function objectBody(t: TS.Type, where: string): string {
    const props = checker.getPropertiesOfType(t);
    const strIdx = checker.getIndexInfoOfType(t, ts.IndexKind.String);
    const numIdx = checker.getIndexInfoOfType(t, ts.IndexKind.Number);
    if (numIdx && !strIdx) throw new Unsupported(where, 'numeric index signature');
    // `known` keeps every declared name, so strict mode never flags a DROPPED one as excess; only the
    // data properties are actually validated.
    const known = props.map(s => s.name);
    let out = `${OBJ_GUARD}  let ok = true;\n`;

    for (const s of props) {
      const pt = typeOfProp(s);
      if (isDropped(s, pt)) continue;
      const acc  = access('v', s.name);
      const path = `p + ${lit(propPath(s.name))}`;
      const body = member(pt, acc, path, `${where}.${s.name}`, '    ');
      // `in` walks the prototype chain, so a key shadowed by `Object.prototype` (`__proto__`,
      // `toString`, `constructor`) reads as present on EVERY object — which misdiagnoses a missing key
      // and, where the member type is unconstrained, accepts an object that lacks it. `Object.hasOwn`
      // is correct but ~3x slower, so it is reserved for the keys that need it: `JSON.parse` can never
      // produce an `undefined` VALUE, so for every other key `!== undefined` is an exact own-presence
      // test on a JSON payload.
      const needsHasOwn = PROTO_KEYS.has(s.name) || (pt.flags & F.Undefined) !== 0
        || (pt.isUnion() && pt.types.some(m => m.flags & F.Undefined));
      const present = needsHasOwn ? `Object.hasOwn(v, ${lit(s.name)})` : `${acc} !== undefined`;
      out += (s.flags & ts.SymbolFlags.Optional)
        ? `  if (${present}${needsHasOwn ? ` && ${acc} !== undefined` : ''}) {\n${body}\n  }\n`
        : `  if (!(${present})) { E(${path}, 'required property missing', undefined, e); ok = false; }\n  else {\n${body}\n  }\n`;
    }

    if (strIdx) {
      const c = check(strIdx.type, 'x', `K(p, k)`, `${where}[string]`);
      const skip = known.length ? `if (${lit(known)}.includes(k)) continue;\n    ` : '';
      const inner = c.expr === 'true' ? ''
        : c.reports ? `    if (!(${c.expr})) ok = false;\n`
        : `    if (!(${c.expr})) { E(K(p, k), ${lit(c.msg)}, x, e); ok = false; }\n`;
      out += `  for (const k of Object.keys(v)) { ${skip}const x = v[k];\n${inner}  }\n`;
    } else if (reject && known.length) {
      out += `  for (const k of Object.keys(v)) if (!${lit(known)}.includes(k)) { E(K(p, k), 'unexpected property', v[k], e); ok = false; }\n`;
    }
    return `${out}  return ok;`;
  }

  try {
    const arms = Array.isArray(root) ? root as readonly TS.Type[] : undefined;
    const single = arms === undefined ? root as TS.Type : arms.length === 1 ? arms[0] : undefined;
    if (arms !== undefined && arms.length === 0) return { refused: 'contract declares no arms' };

    let rootCheck: Check;
    if (single !== undefined) {
      rootCheck = check(single, 'value', `''`, '');
    } else {
      const name = `T${n++}`;
      bodies.push(null);
      const slot = bodies.length - 1;
      bodies[slot] = `function ${name}(v, p, e) {\n${unionBody(arms!, '')}\n}`;
      rootCheck = { expr: `${name}(value, '', e)`, msg: '', reports: true };
    }
    const entry = rootCheck.reports
      ? `  const e = []; ${rootCheck.expr}; return e;`
      : `  const e = []; if (!(${rootCheck.expr})) E('', ${lit(rootCheck.msg)}, value, e); return e;`;
    const src = `'use strict';\nconst E = (p, m, v, e) => e.push({ path: p || '.', message: m, value: v });\n`
      + `const K = (p, k) => p + (/^[A-Za-z_$][\\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');\n`
      + `${bodies.join('\n')}\nreturn function validate(value) {\n${entry}\n};`;
    return { src, warnings };
  } catch (err) {
    if (err instanceof Unsupported) return { refused: err.message };
    throw err;
  }
}

/** Instantiate a generated validator. The source is emitted by {@link generateValidator} from a type
 *  in this process — never from user input — and is plain JS with no free identifiers but `Object`. */
export function compileValidator(src: string): Validator {
  return new Function(src)() as Validator;
}
