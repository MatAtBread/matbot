import type { ToolContext, FormField } from '@matatbread/matbot-plugin-api';
import { CONFIRM_YES, CONFIRM_NO } from '@matatbread/matbot-plugin-api';

// Privileged actions gate on an out-of-band yes/no. Use a structured `confirm` field so rich frontends
// render real buttons and the affirmative is the canonical CONFIRM_YES token — never a parse of the
// rendered (and potentially localised) label. Defaults to CONFIRM_NO, which is what makes a
// non-interactive caller (the web server's direct tool endpoints, a frontend with no prompt UI) decline
// rather than proceed.
export async function confirmAction(ctx: ToolContext, label: string): Promise<boolean> {
  const field: FormField = { name: 'confirm', label, type: 'confirm', default: CONFIRM_NO };
  const answer = await ctx.prompt(field);
  return answer.trim().toLowerCase() === CONFIRM_YES;
}
