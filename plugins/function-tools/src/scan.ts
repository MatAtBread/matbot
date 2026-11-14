// Scanning model-authored TypeScript without a compiler — the browser has none, and a definition is read
// before anything compiles it. Shared by the function-like plugins that take source from a model:
// function-tools' signatures and packages, and tool-store's shapes.

/**
 * If `s[i]` opens something whose contents carry no structure — a string, a template, a line or block
 * comment, a regex literal — return the index of its LAST character, so a scanning loop can jump `i`
 * there; -1 otherwise. An unterminated comment or template runs to the end of the source.
 *
 * Every scanner of model-authored source goes through this. Comments used to be scanned as code, which
 * made an apostrophe in prose (`another conversation's provider`) open a string literal that swallowed the
 * rest of the definition: the body was then never located and `define` reported a missing return type — a
 * misleading error about a line the author had written correctly. The same apostrophe OUTSIDE a comment
 * (prose around a tool-store shape: "Note's fields:") is why a `'`/`"` that reaches the end of its line is
 * not a string at all: a real one cannot span a newline, and treating the rest as inert copied its comments
 * verbatim into a collapsed one-line contract, commenting out every arm after them.
 */
export function inertEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '/' && s[i + 1] === '/') { const nl = s.indexOf('\n', i + 2); return nl === -1 ? s.length - 1 : nl - 1; }
  if (c === '/' && s[i + 1] === '*') { const close = s.indexOf('*/', i + 2); return close === -1 ? s.length - 1 : close + 1; }
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === c) return j;
      if (s[j] === '\n' && c !== '`') return -1;
    }
    return c === '`' ? s.length - 1 : -1;
  }
  // A regex literal is inert too, and for the same reason comments are: `/[A-Za-z'-]+/` or
  // `/"[^"]+"/` carries quote characters that are punctuation to the regex and a string opener to a
  // scanner. An odd number of them swallows the rest of the definition, the body is never located,
  // and the tool is dropped — silently, since the reported error is about brace balance.
  // Regex or division is decided by the previous significant token: after a value (identifier,
  // number, `)`, `]`) a `/` divides; after a punctuator or a keyword like `return`, it opens a regex.
  if (c === '/') {
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j] ?? '')) j--;
    const prev = s[j] ?? '';
    const word = /[A-Za-z0-9_$]/.test(prev) ? (s.slice(0, j + 1).match(/[A-Za-z0-9_$]+$/)?.[0] ?? '') : '';
    const divides = prev === ')' || prev === ']' || prev === '.'
      || (word !== '' && !REGEX_PRECEDING_KEYWORDS.has(word));
    if (!divides) {
      for (let k = i + 1; k < s.length; k++) {
        if (s[k] === '\\') { k++; continue; }
        // Inside a character class a `/` is literal, so it must not end the literal.
        if (s[k] === '[') { for (k++; k < s.length; k++) { if (s[k] === '\\') { k++; continue; } if (s[k] === ']') break; } continue; }
        if (s[k] === '/') return k;   // trailing flags are ordinary identifier chars — harmless
        if (s[k] === '\n') break;     // unterminated on its line: it was division after all
      }
    }
  }
  return -1;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
]);

/** Walk from the `(` at `open` to its matching `)`, skipping strings and comments; -1 if unbalanced. */
export function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Walk from the `{` at `open` to its matching `}`, skipping strings and comments; -1 if unbalanced. */
export function matchBrace(s: string, open: number): number {
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

/** Replace comments with whitespace, leaving string literals untouched. */
export function withoutComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const end = inertEnd(s, i);
    if (end < 0) { out += s[i]; continue; }
    out += s[i] === '/' ? ' ' : s.slice(i, end + 1);
    i = end;
  }
  return out;
}
