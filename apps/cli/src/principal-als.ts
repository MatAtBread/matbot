import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal, PrincipalCarrier } from '@matatbread/matbot-core';

/**
 * Node `PrincipalCarrier` backed by `AsyncLocalStorage`. Each `run`/`enter` scope is isolated per
 * async flow, so the many concurrent per-session `pump` loops (and per-request frontend handlers)
 * each carry their own principal without leaking into one another — the multi-user case ALS exists
 * for. The browser counterpart is `createConstantPrincipalCarrier` (single principal, no isolation).
 */
export function createAlsPrincipalCarrier(): PrincipalCarrier {
  const als = new AsyncLocalStorage<Principal>();
  return {
    current(): Principal {
      const p = als.getStore();
      if (p === undefined) {
        throw new Error('No principal in context — currentPrincipal() called outside any runAs/enter scope.');
      }
      return p;
    },
    tryCurrent: () => als.getStore(),
    run: (principal, fn) => als.run(principal, fn),
    enter(principal): void {
      if (als.getStore() !== undefined) {
        throw new Error('A principal is already established — enter() is for entry points; use runAs for nested/delegated scopes.');
      }
      als.enterWith(principal);
    },
  };
}
