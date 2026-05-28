import type { Hook, HookContext, Vault } from '@matbot/core';

export function createPiiScrubHook(vault: Vault, priority = 10): Hook {
  return {
    point:    'after:response',
    priority,
    async handler(ctx: HookContext): Promise<HookContext> {
      const session = ctx.session;
      const messages = session.messages.map(msg => {
        const content = msg.content.map(c => {
          if (c.type !== 'text') return c;
          return { ...c, text: vault.scrub(c.text) };
        });
        return { ...msg, content };
      });
      return { ...ctx, session: { ...session, messages } };
    },
  };
}

/**
 * Hook that enforces rate limits.  Returns the context with `abort` set when
 * the limit is exceeded; the runner will short-circuit on a non-null `abort`.
 */
export function createRateLimitHook(
  check:    (principalId: string) => { allowed: boolean; resetAt: number },
  priority = 5,
): Hook {
  return {
    point:    'before:submit',
    priority,
    async handler(ctx: HookContext): Promise<HookContext | void> {
      const result = check(ctx.principal.id);
      if (result.allowed) return;
      const resetIn = Math.ceil((result.resetAt - Date.now()) / 1000);
      return { ...ctx, abort: `Rate limit exceeded. Retry in ${resetIn}s.` };
    },
  };
}
