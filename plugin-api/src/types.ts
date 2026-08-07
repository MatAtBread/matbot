/*
 * The plugin-facing type surface, one file per domain. It was a single 1,195-line module — the first
 * thing a third-party author opens and the last thing they can hold in their head. The `── Section ──`
 * banners it had already grown are the split, so each file is the unit its banner described.
 *
 * This barrel re-exports them in the original order, so every `from './types.js'` import across the
 * repo — and `index.ts`'s `export type *` — is byte-identical in effect.
 */

export * from './types/primitives.js';
export * from './types/principal.js';
export * from './types/provider.js';
export * from './types/messages.js';
export * from './types/system-context.js';
export * from './types/hooks.js';
export * from './types/storage.js';
export * from './types/knowledge.js';
export * from './types/typescript.js';
export * from './types/tools.js';
export * from './types/builtin-tools.js';
export * from './types/files.js';
export * from './types/frontend.js';
export * from './types/vault.js';
export * from './types/health.js';
export * from './types/registries.js';
export * from './types/events.js';
export * from './types/session-runner.js';
export * from './types/steering.js';
