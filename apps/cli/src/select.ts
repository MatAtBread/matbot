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
}

export function renderSelect(opts: readonly FormOption[], def: string | undefined): RenderedSelect {
  const isDefault = (o: FormOption): boolean =>
    def !== undefined && optionValue(o).toLowerCase() === def.toLowerCase();
  const inline = opts.map(o => (isDefault(o) ? optionLabel(o).toUpperCase() : optionLabel(o))).join('/');
  if (inline.length <= INLINE_BUDGET) return { lines: [], hint: inline };
  return {
    lines: opts.map((o, i) => `  ${i + 1}) ${optionLabel(o)}${isDefault(o) ? '  (default)' : ''}`),
    hint:  opts.length > 1 ? `1-${opts.length}` : '1',
  };
}

/**
 * Resolve what was typed to an option's VALUE, or `undefined` for "not one of these".
 *
 * A number is the position shown, which is the one form that is always short enough to type and cannot be
 * ambiguous. Otherwise an exact value or label wins, then a UNIQUE prefix of either — ambiguous is a miss,
 * because resolving it to the first match is how a long shared prefix picked an answer nobody chose.
 */
export function resolveSelect(opts: readonly FormOption[], raw: string): string | undefined {
  const typed = raw.trim();
  if (typed === '') return undefined;

  if (/^\d+$/.test(typed)) {
    const at = opts[Number(typed) - 1];
    return at !== undefined ? optionValue(at) : undefined;
  }

  const lower = typed.toLowerCase();
  const exact = opts.find(o => optionValue(o).toLowerCase() === lower || optionLabel(o).toLowerCase() === lower);
  if (exact !== undefined) return optionValue(exact);

  const starts = opts.filter(o => optionValue(o).toLowerCase().startsWith(lower)
                               || optionLabel(o).toLowerCase().startsWith(lower));
  const only = starts.length === 1 ? starts[0] : undefined;
  return only !== undefined ? optionValue(only) : undefined;
}
