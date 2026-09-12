/**
 * A store's `shape` is LLM-authored TypeScript arriving as a string, so it is read the way any
 * model-authored source has to be: comments stripped first, then scanned with brace matching rather
 * than matched against an end-anchored pattern.
 *
 * Both failures were observed. A shape whose declaration is followed by anything — a trailing `//`
 * note, a blank prose line — missed an anchor on `}\s*$` and degraded to `Record<string, unknown>`,
 * losing the document type from the generated contract silently. Worse, a comment *inside* the
 * declaration survived into the collapsed one-line contract, where `// the note body` comments out
 * every arm after it: an unparseable `toolContract`, which is a refusal for that tool.
 */

/** Index of the last char of an inert run (comment or string literal) opening at `i`; -1 if none does. */
function inertEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '/' && s[i + 1] === '/') { const nl = s.indexOf('\n', i + 2); return nl === -1 ? s.length - 1 : nl - 1; }
  if (c === '/' && s[i + 1] === '*') { const close = s.indexOf('*/', i + 2); return close === -1 ? s.length - 1 : close + 1; }
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === c) return j;
    }
    return s.length - 1;
  }
  return -1;
}

/** Replace comments with a space, leaving string literals alone — `kind: 'a//b'` is a value, not a comment. */
function withoutComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const end = inertEnd(s, i);
    if (end < 0) { out += s[i]; continue; }
    out += s[i] === '/' ? ' ' : s.slice(i, end + 1);
    i = end;
  }
  return out;
}

/** Walk from the `{` at `open` to its matching `}`, skipping strings; -1 if unbalanced. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the first `;` at bracket depth 0 — a type alias's terminator, not a member separator. */
function aliasEnd(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === ']' || c === '>') { if (depth > 0) depth--; }
    else if (c === ';' && depth === 0) return i;
  }
  return -1;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The shape's declared NAME, for prose (`Store<RememberedFact>`). */
export function shapeName(shape: string): string | undefined {
  return withoutComments(shape).match(/\b(?:interface|type)\s+(\w+)/)?.[1];
}

/**
 * The store's declared `shape` as an INLINE structural type, so the synthesised `toolContract`
 * references no external name (the shape type is defined only in this string, not in any scannable
 * source). An `interface X { … }` → `{ … }`; a `type X = T` → `T`; anything else →
 * `Record<string, unknown>`. Whitespace is collapsed to keep the emitted contract on one line. A shape
 * that itself references a named type would leave that name dangling — the fix there is to export that
 * type (so the dts can import it), not to inline it here.
 */
export function shapeType(shape: string): string {
  return parseShape(shape).type;
}

/** The outcome of reading a shape: the inline type, plus why it is not the author's if it isn't. */
export interface ShapeParse {
  /** The shape as an inline structural type — `Record<string, unknown>` when nothing usable was read. */
  type:   string;
  /** Why no usable type was read; `undefined` when one was. The caller decides whether that is fatal. */
  fault?: string;
}

/**
 * As {@link shapeType}, but saying why when the answer is not the author's type.
 *
 * The fallback is a plausible-looking contract — a document of anything, which validates everything —
 * so a shape that failed to parse produces a store that works and checks nothing, and the only symptom
 * is types that are quietly useless. Silence here cost an hour of someone's debugging. Nothing in this
 * module decides what to do about a fault: a boundary that has an author present refuses, and a
 * restart reading an already-persisted def warns.
 */
export function parseShape(shape: string): ShapeParse {
  const s = withoutComments(shape);
  const fallback = 'Record<string, unknown>';

  const iface = s.match(/\binterface\s+\w+\s*(?:extends\s+[^{]+)?\{/);
  if (iface !== null) {
    const open  = (iface.index ?? 0) + iface[0].length - 1;
    const close = matchBrace(s, open);
    if (close === -1) return { type: fallback, fault: 'the interface body opens with `{` that has no matching `}`.' };
    const body = collapse(s.slice(open, close + 1));
    // An empty body is a parse that SUCCEEDED and still carries nothing. The form that reaches here is
    // `interface X extends Y {}`: the base is matched but not resolved — only the braces are inlined —
    // so the emitted document type is `{}`, which describes no document at all.
    if (/^\{\s*\}$/.test(body)) {
      return {
        type: fallback,
        fault: iface[0].includes('extends')
          ? 'the interface body is empty and `extends` is not resolved — only the braces are inlined, so the base type’s members are lost. Declare the members literally in this shape, or export the base type so it can be referenced by name.'
          : 'the interface declares no members, so it describes no document.',
      };
    }
    return { type: body };
  }

  const alias = s.match(/\btype\s+\w+\s*=\s*/);
  if (alias !== null) {
    const rest = s.slice((alias.index ?? 0) + alias[0].length);
    const end  = aliasEnd(rest);
    const text = collapse(end === -1 ? rest : rest.slice(0, end));
    if (text !== '') return { type: text };
    return { type: fallback, fault: 'the type alias has nothing on the right of `=`.' };
  }

  return { type: fallback, fault: 'no `interface X { … }` or `type X = …` declaration was found. Give one, with its members written out — they are inlined into the store’s tool contract, so a type declared elsewhere cannot be referenced by name.' };
}
