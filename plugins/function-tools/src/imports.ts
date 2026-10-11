/** The identifier a rewritten `import(…)` call lands on — injected per call, so a body reaches a module
 *  only through the gate. Reserved, like the other injected names. */
export const IMPORT_FN = '__toolImportModule';

/**
 * Rewrite every `import(…)` CALL in already-stripped JavaScript to {@link IMPORT_FN}`(…)`, leaving the
 * argument expression untouched.
 *
 * Why a rewrite rather than an injected name the author uses directly: `import` is a reserved word, so
 * there is no binding to shadow (`const import` and a parameter named `import` are both syntax errors),
 * and the spelling a model reaches for first is the real one. Rewriting the call keeps that spelling,
 * keeps a computed specifier working — the argument passes through, so the gate sees the string the body
 * actually built — and leaves the type-check reading the source AS WRITTEN, which is what keeps a
 * diagnostic's caret over text its author recognises.
 *
 * It is a scanner rather than one regular expression because the rewrite must not reach inside string,
 * template or comment context, and a body that GENERATES source containing `import(` is an ordinary
 * thing for a model to write. The two cases that defeat a single pattern are template-literal
 * interpolation (which nests arbitrarily: `` `${ `${x}` }` ``) and telling a regex literal from
 * division, which needs the previous significant token. Both are tracked here.
 *
 * `import.meta` is untouched, having no call parens; so is a static `import` statement, which cannot
 * appear in a function body at all.
 */
export function rewriteImportCalls(source: string): string {
  let out = '';
  let i = 0;
  // The last significant (non-space, non-comment) character of code emitted so far. It decides whether a
  // `/` opens a regex literal or divides — the one piece of parser state a scanner cannot do without.
  let prev = '';
  // Template-literal nesting: each entry is a `${` depth counter for one template. Inside an
  // interpolation we are in CODE again, so an `import(` there must still be rewritten.
  const templates: number[] = [];
  let braces = 0;   // brace depth within the innermost interpolation

  const WORD = /[A-Za-z0-9_$]/;
  // After one of these, a `/` begins a regex; after an identifier, number, `)` or `]` it divides.
  const REGEX_OK = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
  // A whole-word `import` followed by `(`, used to decide an ambiguous `/` below.
  const IMPORT_CALL = /(?<![\w$.])import\s*\(/;
  // `\s*$` because `out` still carries the whitespace between the keyword and the `/`: anchoring on the
  // keyword alone never matched, which read `return /x/.test(s)` as division and then swallowed the rest
  // of the body as a string. The lookbehind keeps `x.return` and `myreturn` out — a property access and
  // an identifier that merely ends in a keyword both divide.
  const KEYWORD_BEFORE_REGEX = /(?<![.\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/;

  const regexAllowed = (): boolean =>
    REGEX_OK.has(prev) || KEYWORD_BEFORE_REGEX.test(out);

  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];

    // ── template literals, with interpolations treated as code ──────────────
    // AHEAD of comments and strings, because raw template text has no such context: `//` in a URL is
    // part of the string, and so is an apostrophe. Tested first, a comment branch ate the rest of the
    // line INCLUDING the closing backtick, and every later `import(` went unrewritten — a clean type
    // check followed by ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, or an ungated import with no runner.
    if (c === '`') {
      if (templates.length > 0 && braces === 0) { templates.pop(); braces = templates.pop() ?? 0; }
      else { templates.push(braces); templates.push(0); braces = 0; }
      out += c; i += 1; prev = '`'; continue;
    }
    if (templates.length > 0) {
      if (c === '$' && next === '{') { braces += 1; out += '${'; i += 2; prev = '{'; continue; }
      if (c === '{' && braces > 0) { braces += 1; out += c; i += 1; prev = '{'; continue; }
      if (c === '}' && braces > 0) { braces -= 1; out += c; i += 1; prev = '}'; continue; }
      if (braces === 0) {
        // Raw template text: copy it verbatim, escapes included, until a `${` or the closing backtick.
        if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        out += c; i += 1; continue;
      }
    }

    // ── comments ────────────────────────────────────────────────────────────
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += source.slice(i, stop); i = stop; continue;      // `prev` unchanged: a comment is not a token
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop); i = stop; continue;
    }

    // ── string literals ─────────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j += 1; break; }
        j += 1;
      }
      out += source.slice(i, j); i = j; prev = c; continue;
    }

    // ── regex literals ──────────────────────────────────────────────────────
    if (c === '/' && regexAllowed()) {
      let j = i + 1, klass = false, closed = false;
      while (j < source.length) {
        const d = source[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                               // unterminated: it was division after all
        if (d === '[') klass = true;
        else if (d === ']') klass = false;
        else if (d === '/' && !klass) { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j < source.length && WORD.test(source[j] as string)) j += 1;   // flags
        // `}` is the one predecessor that is genuinely AMBIGUOUS: it ends a block (so a `/` after it
        // begins a regex) and it ends an object literal or function expression (so a `/` after it
        // divides). Nothing short of a parser tells them apart, so where the two readings disagree about
        // whether an import is gated, this takes the gated one: a candidate regex that would swallow an
        // `import(` is read as division instead. `const n = {} / a; import('node:fs') / b;` otherwise
        // made the whole middle one regex literal, and the import went unrewritten — inert under the vm
        // runner, but genuinely ungated under the `new AsyncFunction` fallback (`function_timeout_ms: 0`,
        // and the browser), where a real `import()` resolves. The cost is that a regex mentioning
        // `import(` immediately after a block close is read as division; a statement starting with a
        // regex literal is already vanishingly rare, and that one is rarer still.
        if (prev !== '}' || !IMPORT_CALL.test(source.slice(i, j))) {
          out += source.slice(i, j); i = j; prev = '/'; continue;
        }
      }
    }

    // ── the rewrite itself ──────────────────────────────────────────────────
    // A whole-word `import` followed by `(`, and not a property access (`m.import(…)`, which is some
    // object's own method and none of our business).
    if (c === 'i' && source.startsWith('import', i)
        && !WORD.test(source[i - 1] ?? '') && prev !== '.'
        && /^\s*\(/.test(source.slice(i + 6))) {
      // A block immediately after the closing paren means this is NOT a call being rewritten — it is a
      // method shorthand named `import` (`{ import(x) { … } }`, legal: a property name may be a reserved
      // word), or a call whose statement happens to be followed by a block. Renaming the first breaks
      // every later `o.import(…)`, silently; leaving the second alone would hand back an ungated import
      // under the `new AsyncFunction` fallback. The two are indistinguishable without a parser, so both
      // are REFUSED, which fails closed and names the fix — the same answer the injected names already
      // get, being reserved.
      if (blockFollows(source, i + 6)) {
        throw new Error(
          "`import` cannot be used as a method name in a tool_function body, and an `import(…)` statement "
          + 'cannot be followed by a block: `import(…)` is rewritten onto the gated module loader, so the '
          + 'name is reserved. Rename the method (e.g. `load(…)`), or separate the statement from the block.',
        );
      }
      out += IMPORT_FN; i += 6; prev = 't'; continue;
    }

    out += c; i += 1;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

/** Whether the parenthesised group starting at or after `from` is immediately followed by `{`. Strings are
 *  skipped so a brace inside one does not count; a group that never closes answers no. */
function blockFollows(source: string, from: number): boolean {
  let i = from;
  while (i < source.length && /\s/.test(source[i] as string)) i += 1;
  if (source[i] !== '(') return false;
  let depth = 0;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    i += 1;
  }
  if (depth !== 0) return false;
  while (i < source.length && /\s/.test(source[i] as string)) i += 1;
  return source[i] === '{';
}
