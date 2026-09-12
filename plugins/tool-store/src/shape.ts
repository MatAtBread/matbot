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
      // An apostrophe and a quote are the same character, so prose around a model-authored shape
      // ("Note's fields:") opens a literal that never closes. Treating the rest as inert copies its
      // comments verbatim into the collapsed one-line contract — precisely the failure this module
      // exists to prevent, and silently. A real `'`/`"` literal cannot span a newline, so one that
      // reaches the end of its line is not a string; nor is a run that reaches the end of the input.
      if (s[j] === '\n' && c !== '`') return -1;
    }
    return -1;
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

const CLOSER: Record<string, string> = { '{': '}', '(': ')', '[': ']', '<': '>' };

/** Walk from the opener at `open` to its match, skipping comments and strings; -1 if unbalanced. */
function matchBracket(s: string, open: number): number {
  const o = s[open];
  const c = o === undefined ? undefined : CLOSER[o];
  if (c === undefined) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    if (s[i] === '=' && s[i + 1] === '>') { i++; continue; }   // an arrow, not a closing angle
    if (s[i] === o) depth++;
    else if (s[i] === c) { depth--; if (depth === 0) return i; }
  }
  return -1;
}


/**
 * Index of the `{` that opens an interface body: the first brace at angle-bracket depth 0 after the
 * declaration. Scanned rather than matched, because `extends Base<{ a: string }>` puts a brace inside the
 * heritage clause — a `[^{]+` pattern stops there and hands back the base's TYPE ARGUMENT as the body,
 * which is a wrong document type reported as a good one.
 */
function interfaceBodyStart(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') { i++; continue; }   // an arrow, not a closing angle
    if (c === '<') depth++;
    else if (c === '>') { if (depth > 0) depth--; }
    else if (c === '{' && depth === 0) return i;
  }
  return -1;
}

const WORD = /[A-Za-z0-9_$.]/;

/**
 * Index just past the type expression starting at `from` — units (`{…}`, `(…)`, a name, a string literal)
 * joined by `|`/`&`, with `<…>`/`[…]` suffixes. It STOPS at the first thing that cannot continue a type,
 * which is what lets the caller see that something follows.
 *
 * Reading to the end of the input instead is how `type Note = { text: string }` followed by a line of
 * prose became the document type `{ text: string } Stored per user.` — emitted with no fault, accepted at
 * create, and unparseable by the time anything downstream read it.
 */
function typeExprEnd(s: string, from: number): number {
  let i = from;
  const skipWs = (): void => { while (i < s.length && /\s/.test(s[i] ?? '')) i++; };
  for (;;) {
    skipWs();
    if (i >= s.length) return i;
    const c = s[i] ?? '';
    if (c === '|' || c === '&') { i++; continue; }            // a leading or joining connector
    if (c in CLOSER) {
      const close = matchBracket(s, i);
      if (close === -1) return s.length;                      // unbalanced: the caller's own check reports it
      i = close + 1;
    } else {
      const inert = inertEnd(s, i);
      if (inert >= 0) i = inert + 1;                          // a string-literal type
      else if (WORD.test(c)) { while (i < s.length && WORD.test(s[i] ?? '')) i++; }
      else return i;                                          // not something a type can start with
    }
    for (;;) {                                                // `<…>` / `[…]` suffixes bind to the unit
      const mark = i;
      skipWs();
      const n = s[i] ?? '';
      if ((n === '<' || n === '[') && matchBracket(s, i) !== -1) { i = matchBracket(s, i) + 1; continue; }
      i = mark; break;
    }
    const mark = i;                                           // only a connector continues the expression
    skipWs();
    const n = s[i] ?? '';
    if (n === '|' || n === '&') { i++; continue; }
    i = mark;
    return i;
  }
}

/**
 * Where each `interface X` / `type X` declaration starts, at depth 0 and outside comments and strings.
 *
 * A shape is ONE document type, not a module, and this is what enforces it. Taking the first declaration
 * and ignoring the rest is silent and confidently wrong: two interfaces emitted the first one's body, and
 * `type Id = string; type Note = { id: Id }` emitted `string` — the HELPER type as the document.
 */
function declarationStarts(s: string): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i] ?? '';
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { if (depth > 0) depth--; }
    else if (depth === 0 && /[A-Za-z_$]/.test(c) && !WORD.test(s[i - 1] ?? ' ')) {
      const m = /^(?:interface|type)\s+\w+/.exec(s.slice(i));
      if (m !== null) { out.push(i); i += m[0].length - 1; }
    }
  }
  return out;
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

  // ONE declaration, and nothing after it. Both halves are the same rule — the shape is the document
  // type, not a module — and both were silently violable: a second declaration was ignored (the FIRST
  // won, so `type Id = string; type Note = { id: Id }` emitted `string`), and trailing prose was swept
  // into the type. Each produced a confident, wrong contract with no fault.
  const decls = declarationStarts(s);
  if (decls.length > 1) {
    const names = decls.map(i => /^(?:interface|type)\s+(\w+)/.exec(s.slice(i))?.[1] ?? '?');
    return {
      type: fallback,
      fault: `the shape declares ${decls.length} types (${names.join(', ')}) — it must be exactly ONE. `
        + 'Its members are inlined into the store\u2019s tool contract, so a type declared alongside cannot be '
        + `referenced by name: write ${names[names.length - 1] ?? 'the document type'}'s members out in full.`,
    };
  }
  const trailing = (from: number): string | undefined => {
    const rest = s.slice(from).trim();
    return rest === '' ? undefined
      : `the declaration is followed by text that is not part of it (${JSON.stringify(collapse(rest).slice(0, 40))}). `
        + 'A shape is one type declaration and nothing else; put any note in a `//` comment.';
  };

  const iface = s.match(/\binterface\s+\w+/);
  if (iface !== null) {
    const open = interfaceBodyStart(s, (iface.index ?? 0) + iface[0].length);
    if (open === -1) return { type: fallback, fault: 'the interface declaration is not followed by a `{ … }` body.' };
    const close = matchBracket(s, open);
    if (close === -1) return { type: fallback, fault: 'the interface body opens with `{` that has no matching `}`.' };
    const body = collapse(s.slice(open, close + 1));
    // An empty body is a parse that SUCCEEDED and still carries nothing. The form that reaches here is
    // `interface X extends Y {}`: the base is matched but not resolved — only the braces are inlined —
    // so the emitted document type is `{}`, which describes no document at all.
    if (/^\{\s*\}$/.test(body)) {
      return {
        type: fallback,
        fault: /\bextends\b/.test(s.slice((iface.index ?? 0), open))
          ? 'the interface body is empty and `extends` is not resolved — only the braces are inlined, so the base type’s members are lost. Declare the members literally in this shape, or export the base type so it can be referenced by name.'
          : 'the interface declares no members, so it describes no document.',
      };
    }
    const after = trailing(close + 1);
    if (after !== undefined) return { type: fallback, fault: after };
    return { type: body };
  }

  const alias = s.match(/\btype\s+\w+\s*=\s*/);
  if (alias !== null) {
    const from = (alias.index ?? 0) + alias[0].length;
    const end  = typeExprEnd(s, from);
    const text = collapse(s.slice(from, end));
    if (text === '') return { type: fallback, fault: 'the type alias has nothing on the right of `=`.' };
    const rest  = s.slice(end).trimStart();
    const after = trailing(end + (rest.startsWith(';') ? s.slice(end).indexOf(';') + 1 : 0));
    if (after !== undefined) return { type: fallback, fault: after };
    return { type: text };
  }

  return { type: fallback, fault: 'no `interface X { … }` or `type X = …` declaration was found. Give one, with its members written out — they are inlined into the store’s tool contract, so a type declared elsewhere cannot be referenced by name.' };
}
