import { optionLabel, optionValue } from '@matatbread/matbot-core';
import type { FormOption } from '@matatbread/matbot-core';

/**
 * How a terminal renders and resolves a `select`.
 *
 * It is its own module because the two halves have to agree: what is SHOWN is the only addressing scheme
 * the reader has, and the resolver used to accept nothing but a label prefix. That was adequate while
 * every select in the repo was two or three short words, and stopped being adequate the moment the
 * permission gate offered four standing answers whose labels are deliberately prose — they share a ~50
 * character prefix (`Always allow function "fetch_prices" to import …`), so the middle two were
 * unreachable in practice, and a near-miss resolved to the field's default, which for a gate is DENY. An
 * answer nobody can type is not an answer, and one that silently means something else is worse.
 */

/** Inline `[a/b/C]` while that stays readable; a numbered list once it does not. */
const INLINE_BUDGET = 56;

export interface RenderedSelect {
  /** Lines to print before the prompt — empty for the inline form. */
  lines:  string[];
  /** What goes in the prompt's brackets. */
  hint:   string;
  /** Whether the options were listed with numbers, which is the only thing that makes a number an
   *  ADDRESS. Passed back to {@link resolveSelect}, because what was shown is what may be typed: with the
   *  inline form, `options: ['2', '4', '8']` displays no numbers at all, and reading `2` as a position
   *  there answers `4` to a question nobody asked. */
  numbered: boolean;
}

export function renderSelect(opts: readonly FormOption[], def: string | undefined): RenderedSelect {
  const isDefault = (o: FormOption): boolean =>
    def !== undefined && optionValue(o).toLowerCase() === def.toLowerCase();
  const inline = opts.map(o => (isDefault(o) ? optionLabel(o).toUpperCase() : optionLabel(o))).join('/');
  if (inline.length <= INLINE_BUDGET) return { lines: [], hint: inline, numbered: false };
  return {
    lines:    opts.map((o, i) => `  ${i + 1}) ${optionLabel(o)}${isDefault(o) ? '  (default)' : ''}`),
    hint:     opts.length > 1 ? `1-${opts.length}` : '1',
    numbered: true,
  };
}

/**
 * Resolve what was typed to an option's VALUE, or `undefined` for "not one of these".
 *
 * An exact value or label is tried FIRST, then a position (only when the options were actually numbered),
 * then a UNIQUE prefix of either. Ambiguous is a miss, because resolving it to the first match is how a
 * long shared prefix picked an answer nobody chose.
 *
 * Exact-first matters where the two forms collide — numeric option values, as `ask_user` is free to
 * supply (`['2', '4', '8']`). The option's own text is what the reader is looking at; the number is a
 * convenience laid over it, so the text wins and `numbered` keeps the convenience from applying where it
 * was never offered.
 */
export function resolveSelect(opts: readonly FormOption[], raw: string, numbered = false): string | undefined {
  const typed = raw.trim();
  if (typed === '') return undefined;

  const lower = typed.toLowerCase();
  const exact = opts.find(o => optionValue(o).toLowerCase() === lower || optionLabel(o).toLowerCase() === lower);
  if (exact !== undefined) return optionValue(exact);

  if (numbered && /^\d+$/.test(typed)) {
    const at = opts[Number(typed) - 1];
    return at !== undefined ? optionValue(at) : undefined;
  }

  const starts = opts.filter(o => optionValue(o).toLowerCase().startsWith(lower)
                               || optionLabel(o).toLowerCase().startsWith(lower));
  const only = starts.length === 1 ? starts[0] : undefined;
  return only !== undefined ? optionValue(only) : undefined;
}

/** What to do with one typed answer: take it, or say something and ask again. */
export type SelectOutcome = { answer: string } | { retry: string };

/**
 * The whole decision for one typed line, so that it is testable away from a readline.
 *
 * Empty is "take the default", which is a different thing from a miss. A miss says so and asks again,
 * ONCE — an unmatched answer is not a decision, and for a gate the field's default is Deny, so taking it
 * silently read a typo as a refusal. And with `allowOther` a miss is not a miss at all: the free text IS
 * the answer, which is what the web frontend does with it and what collapsing every unmatched answer
 * onto the default quietly stopped doing.
 */
export function answerSelect(
  opts: readonly FormOption[],
  raw:  string,
  o:    { def?: string; allowOther?: boolean; numbered?: boolean; again?: boolean },
): SelectOutcome {
  const typed = raw.trim();
  if (typed === '') return { answer: o.def ?? '' };

  const picked = resolveSelect(opts, typed, o.numbered ?? false);
  if (picked !== undefined) return { answer: picked };

  if (o.allowOther === true) return { answer: typed };
  if (o.again === true) return { answer: o.def ?? typed };
  return { retry: `  "${typed}" is not one of the options${o.numbered === true ? ' — type its number' : ''}.\n` };
}
