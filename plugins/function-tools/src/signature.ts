import type { JSONSchema } from '@matatbread/matbot-plugin-api';

export interface ParsedParam {
  name:      string;
  optional:  boolean;
  type?:     string;
}

export interface ParsedSignature {
  name?:       string;
  params:      ParsedParam[];
  returnType?: string;
  /** Raw parameter-list source (between the parens), types intact — e.g. `check: string, limit?: number`. */
  paramsText:  string;
  /** Raw function body including its braces — e.g. `{ return "hi"; }`. */
  body:        string;
}

/**
 * If `s[i]` opens something whose contents carry no structure — a string, a template, a line or block
 * comment — return the index of its LAST character, so a scanning loop can jump `i` there; -1 otherwise.
 * Unterminated runs to the end of the source.
 *
 * Every scanner below goes through this. Comments used to be scanned as code, which made an apostrophe in
 * prose (`another conversation's provider`) open a string literal that swallowed the rest of the
 * definition: the body was then never located and `define` reported a missing return type — a misleading
 * error about a line the author had written correctly.
 */
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
function matchParen(s: string, open: number): number {
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

/** Replace comments with whitespace, leaving string literals untouched. */
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

/** Drop leading whitespace and any leading comments — a definition is often prefixed with a doc comment,
 *  which is part of neither the head this parses nor the expression `buildAsyncFn` wraps. */
export function stripLeadingTrivia(src: string): string {
  let i = 0;
  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src[i] !== '/' || (src[i + 1] !== '/' && src[i + 1] !== '*')) return src.slice(i);
    i = inertEnd(src, i) + 1;
  }
}

/** Find the function body's opening `{` at/after `from`: the first top-level `{` whose matching `}` is the
 *  final non-space char. A brace-bearing return type (e.g. `: { a: number }`) is skipped over — its `}`
 *  isn't at the end. Tracks `()[]<>` depth (so a `{` inside generics/params isn't mistaken for the body). */
function findBodyOpen(s: string, from: number): number {
  let end = s.length - 1;
  while (end >= 0 && /\s/.test(s[end] as string)) end--;
  if (end < 0 || s[end] !== '}') return -1;
  let depth = 0;
  for (let i = from; i <= end; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') { if (depth > 0) depth--; }
    else if (c === '{' && depth === 0) {
      const close = matchBrace(s, i);
      if (close === end) return i;   // body: its `}` is the last char
      if (close === -1)  return -1;
      i = close;                     // a return-type object literal — skip past it
    }
  }
  return -1;
}

/** Split a parameter list on top-level commas, respecting nested brackets/generics/strings/comments and `=>`. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const inert = inertEnd(s, i);
    if (inert >= 0) { i = inert; continue; }
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') { if (depth > 0) depth--; }
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

function parseParam(seg: string): ParsedParam | null {
  const s = withoutComments(seg).trim();   // `a: string /* the city */` must yield the type `string`
  if (s === '') return null;
  const m = s.match(/^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*(?::\s*([\s\S]+?))?\s*(?:=\s*[\s\S]+)?$/);
  if (m === null) throw new Error(`can't parse parameter "${s}" — use simple named params, e.g. \`name: string\`.`);
  const type = m[3]?.trim();
  return {
    name:     m[1] as string,
    optional: m[2] === '?' || /=\s*\S/.test(s),
    ...(type !== undefined && type !== '' ? { type } : {}),
  };
}

/** Parse a method-shorthand function head (`name(params): ret { … }`). `name` is absent for a lambda. */
export function parseSignature(source: string): ParsedSignature {
  const src  = stripLeadingTrivia(source);
  const head = src.match(/^\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)?\s*\(/);
  if (head === null) throw new Error('not a function definition — expected `name(params) { … }`.');
  const name    = head[1];
  const openIdx = (head.index ?? 0) + head[0].length - 1;
  const closeIdx = matchParen(src, openIdx);
  if (closeIdx === -1) throw new Error('unbalanced parentheses in the parameter list.');

  const params = splitTopLevel(src.slice(openIdx + 1, closeIdx))
    .map(parseParam)
    .filter((p): p is ParsedParam => p !== null);
  // The body is the top-level `{…}` block that runs to the end; everything between `)` and it is the
  // (possibly brace-bearing, e.g. `{ a: number }`) return annotation. Can't just take the first `{` — an
  // object/inline return type has its own braces.
  const bodyOpen = findBodyOpen(src, closeIdx + 1);
  // Say so, rather than falling through to `{}` and letting the caller report the *return type* as missing:
  // an unlocatable body is what an unbalanced brace looks like from here, and blaming the signature sends
  // the author to edit a line that was already correct.
  if (bodyOpen < 0) throw new Error('could not find the function body — check the braces balance and that the definition ends with the body\'s `}`.');
  const between    = src.slice(closeIdx + 1, bodyOpen).trim();
  const returnType = between.startsWith(':') ? between.slice(1).trim() : '';

  return {
    ...(name !== undefined ? { name } : {}),
    params,
    ...(returnType !== '' ? { returnType } : {}),
    paramsText: src.slice(openIdx + 1, closeIdx),
    body:       src.slice(bodyOpen),
  };
}

function tsTypeToSchema(type: string | undefined): JSONSchema {
  const t = type?.trim();
  if (t === 'string') return { type: 'string' };
  if (t === 'number' || t === 'bigint') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t !== undefined && (/\[\]$/.test(t) || /^(readonly\s+)?(Array|ReadonlyArray)\s*</.test(t) || /^readonly\s*\[/.test(t))) return { type: 'array' };
  if (t !== undefined && (t.startsWith('{') || /^(Record|Map)\s*</.test(t))) return { type: 'object' };
  return {};
}

/** Object schema for a defined tool: one property per parameter, non-optional params required. */
export function paramsSchema(params: ParsedParam[]): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = tsTypeToSchema(p.type);
    if (!p.optional) required.push(p.name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
