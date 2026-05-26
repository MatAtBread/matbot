export { VaultImpl }             from './vault.js';
export { AuditLogImpl }          from './audit.js';
export { RateLimiter }           from './rate-limiter.js';
export type { RateLimitResult }  from './rate-limiter.js';
export { createPiiScrubHook,
         createRateLimitHook }   from './hooks.js';
export { hasGrant, checkGrants,
         systemPrincipal }       from './grants.js';
