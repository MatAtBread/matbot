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
        out += source.slice(i, j); i = j; prev = '/'; continue;
      }
    }

    // ── the rewrite itself ──────────────────────────────────────────────────
    // A whole-word `import` followed by `(`, and not a property access (`m.import(…)`, which is some
    // object's own method and none of our business).
    if (c === 'i' && source.startsWith('import', i)
        && !WORD.test(source[i - 1] ?? '') && prev !== '.'
        && /^\s*\(/.test(source.slice(i + 6))) {
      out += IMPORT_FN; i += 6; prev = 't'; continue;
    }

    out += c; i += 1;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}
