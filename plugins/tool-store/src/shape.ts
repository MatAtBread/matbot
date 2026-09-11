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
  const s = withoutComments(shape);

  const iface = s.match(/\binterface\s+\w+\s*(?:extends\s+[^{]+)?\{/);
  if (iface !== null) {
    const open  = (iface.index ?? 0) + iface[0].length - 1;
    const close = matchBrace(s, open);
    if (close !== -1) return collapse(s.slice(open, close + 1));
  }

  const alias = s.match(/\btype\s+\w+\s*=\s*/);
  if (alias !== null) {
    const rest = s.slice((alias.index ?? 0) + alias[0].length);
    const end  = aliasEnd(rest);
    const text = collapse(end === -1 ? rest : rest.slice(0, end));
    if (text !== '') return text;
  }

  return 'Record<string, unknown>';
}
