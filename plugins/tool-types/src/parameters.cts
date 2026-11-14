import type TS from 'typescript';

// The JSON Schema of a function's parameters, from the CHECKER'S RESOLVED TYPES — what a defined tool's
// `inputSchema` is on node. function-tools derives the same thing from the parameter text by hand, which is
// all the browser has; that derivation cannot see a named type, an imported one, an alias, `Omit<…>` or an
// indexed access, and degrades each to `{}`. Here every one of them arrives already evaluated.
//
// Required by the checker's worker, which runs as CommonJS with no loader hooks: hence `.cts`, which node
// strips like any other TypeScript, and `module.exports` rather than an `export`.
//
// The conventions are the hand path's, so the two agree wherever both can answer: the JSON projection of the
// type (`toJSON` wins, a method is absent), a union of scalars as a `type`/`enum` pair, and anything a
// provider or json-validation could not honour — a union with a structural arm, a tuple's positions, a
// function — as the permissive `{}` rather than a constraint that rejects a valid call.

type Schema = Record<string, unknown>;

interface Parameter { name: string; optional: boolean; schema: Schema }

const MAX_DEPTH = 6;

// Their instances stringify to `{}`: state behind accessors or internal slots, so nothing reaches the wire.
const EMPTY_JSON = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'RegExp', 'Promise', 'Error']);

function schemaOf(ts: typeof TS, checker: TS.TypeChecker, location: TS.Node, root: TS.Type): Schema {
  const F = ts.TypeFlags;
  const onPath = new Set<TS.Type>();

  const scalar = (t: TS.Type): { type: string; value?: string | number | boolean } | undefined => {
    if (t.flags & F.StringLiteral)  return { type: 'string',  value: (t as TS.StringLiteralType).value };
    if (t.flags & F.NumberLiteral)  return { type: 'number',  value: (t as TS.NumberLiteralType).value };
    if (t.flags & F.BooleanLiteral) return { type: 'boolean', value: checker.typeToString(t) === 'true' };
    if (t.flags & F.String)  return { type: 'string' };
    if (t.flags & F.Number)  return { type: 'number' };
    if (t.flags & F.Boolean) return { type: 'boolean' };
    if (t.flags & F.Null)    return { type: 'null' };
    return undefined;
  };

  const walk = (t: TS.Type, depth: number): Schema => {
    if (depth > MAX_DEPTH || onPath.has(t)) return {};
    if (t.flags & (F.Any | F.Unknown | F.TypeParameter | F.Never)) return {};

    if (t.isUnion()) {
      const arms = t.types.filter(m => !(m.flags & (F.Undefined | F.Void)));
      if (arms.length === 0) return {};
      if (arms.length === 1) return walk(arms[0]!, depth);
      const scalars = arms.map(scalar);
      // A structural arm makes the union a job for `anyOf`, which json-validation does not enforce.
      if (scalars.some(s => s === undefined)) return {};
      const ss = scalars as { type: string; value?: string | number | boolean }[];
      const open = new Set(ss.filter(s => s.value === undefined).map(s => s.type));
      // `boolean` arrives as `true | false`; both together are the open type, not an enum of two.
      if (ss.filter(s => s.type === 'boolean' && s.value !== undefined).length === 2) open.add('boolean');
      const literals = ss.filter(s => s.value !== undefined && !open.has(s.type));
      const types = [...new Set([...open, ...literals.map(s => s.type)])];
      const typed: Schema = types.length === 1 ? { type: types[0] } : { type: types };
      // `'a' | string` widens: an enum of the literal arms would reject the open one.
      return open.size === 0 ? { ...typed, enum: literals.map(s => s.value) } : typed;
    }

    const s = scalar(t);
    if (s !== undefined) return s.value !== undefined ? { type: s.type, enum: [s.value] } : { type: s.type };
    if (t.flags & (F.BigInt | F.BigIntLiteral | F.ESSymbol | F.UniqueESSymbol)) return {};
    if (t.getCallSignatures().length > 0) return {};

    // `toJSON()` decides what is on the wire: a Date is its string.
    const toJSON = checker.getPropertyOfType(t, 'toJSON');
    if (toJSON !== undefined) {
      const sig = checker.getTypeOfSymbolAtLocation(toJSON, location).getCallSignatures()[0];
      if (sig !== undefined) return walk(checker.getReturnTypeOfSignature(sig), depth + 1);
    }

    onPath.add(t);
    try {
      if (checker.isArrayType(t)) {
        const el = checker.getTypeArguments(t as TS.TypeReference)[0];
        return { type: 'array', ...(el !== undefined ? { items: walk(el, depth + 1) } : {}) };
      }
      if (checker.isTupleType(t)) return { type: 'array' };
      const name = t.getSymbol()?.getName();
      if (name !== undefined && EMPTY_JSON.has(name)) return { type: 'object' };
      if (!(t.flags & F.Object) && !t.isIntersection()) return {};

      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const p of checker.getPropertiesOfType(t)) {
        const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? location);
        if (pt.getCallSignatures().length > 0 && !pt.isUnion()) continue;   // a method: never on the wire
        properties[p.getName()] = walk(pt, depth + 1);
        const optional = (p.flags & ts.SymbolFlags.Optional) !== 0
          || (pt.isUnion() && pt.types.some(m => m.flags & F.Undefined));
        if (!optional) required.push(p.getName());
      }
      const index = checker.getIndexTypeOfType(t, ts.IndexKind.String);
      return {
        type: 'object',
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        ...(required.length > 0 ? { required } : {}),
        ...(index !== undefined ? { additionalProperties: walk(index, depth + 1) } : {}),
      };
    } finally {
      onPath.delete(t);
    }
  };

  return walk(root, 0);
}

/** The function a top-level declaration of `name` gives the file: a function declaration, or a `const`
 *  initialised with a function or arrow expression. `export` or not. */
function findFunction(ts: typeof TS, sf: TS.SourceFile, name: string): TS.SignatureDeclaration | undefined {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined
            && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
      }
    }
  }
  return undefined;
}

/** Each named function's parameters with their schemas; a name the file does not declare is absent. */
function parametersOf(ts: typeof TS, checker: TS.TypeChecker, sf: TS.SourceFile, names: readonly string[]): Record<string, Parameter[]> {
  const out: Record<string, Parameter[]> = {};
  for (const name of names) {
    const fn = findFunction(ts, sf, name);
    if (fn === undefined) continue;
    out[name] = fn.parameters.map((p, i) => ({
      name:     ts.isIdentifier(p.name) ? p.name.text : `arg${i}`,
      optional: p.questionToken !== undefined || p.initializer !== undefined,
      schema:   schemaOf(ts, checker, p, checker.getTypeAtLocation(p)),
    }));
  }
  return out;
}

module.exports = { parametersOf };
