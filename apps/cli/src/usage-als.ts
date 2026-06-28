import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageCarrier, UsageRecord } from '@matatbread/matbot-core';

/**
 * Node `UsageCarrier` backed by `AsyncLocalStorage`. Each turn's `withUsageScope` runs in its own
 * isolated sink, so the concurrent per-session `pump` loops accrue token accounting independently —
 * a completion run inside one turn's tool never lands in another's tally. The browser counterpart is
 * `createSerialUsageCarrier` (single sink, no async isolation).
 */
export function createAlsUsageCarrier(): UsageCarrier {
  const als = new AsyncLocalStorage<UsageRecord[]>();
  return {
    run: (sink, fn) => als.run(sink, fn),
    tryCurrent: () => als.getStore(),
  };
}
