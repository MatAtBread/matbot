import type { ResolveHookSync, LoadHookSync } from 'node:module';

/** The resolve (`.js` import → `.ts` file) and load (strip types, under node_modules too) hooks that loading
 *  matbot's TypeScript-source packages needs, for a host registering them alongside hooks of its own. */
export function typescriptHooks(): { resolve: ResolveHookSync; load: LoadHookSync };
