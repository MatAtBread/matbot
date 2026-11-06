import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageCarrier, UsageScope } from '@matatbread/matbot-core';

/**
 * Node `UsageCarrier` backed by `AsyncLocalStorage`. Each turn's `withUsageScope` runs in its own
 * isolated scope, so the concurrent per-session `pump` loops accrue token accounting independently —
 * a completion run inside one turn's tool never lands in another's tally. The browser counterpart is
 * `createSerialUsageCarrier` (single scope, no async isolation).
 */
export function createAlsUsageCarrier(): UsageCarrier {
  const als = new AsyncLocalStorage<UsageScope>();
  return {
    run: (scope, fn) => als.run(scope, fn),
    tryCurrent: () => als.getStore(),
  };
}
