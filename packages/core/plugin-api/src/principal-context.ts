import type { Principal } from './types.js';

/**
 * Ambient carrier for the security {@link Principal} — the single mechanism by which any layer
 * (runner, hook, tool, or a Store/FileStore/Vault/KnowledgeIndex backend) discovers *who*
 * originated the current operation, without that identity being threaded through every signature.
 *
 * The host installs one platform implementation at boot via {@link installPrincipalCarrier}:
 *   - node (multi-user, concurrent turns): an `AsyncLocalStorage`-backed carrier — each turn /
 *     request runs in its own isolated scope (see the node app's `createAlsPrincipalCarrier`).
 *   - browser / any single-principal realm: {@link createConstantPrincipalCarrier} — there is only
 *     ever one principal, so no async isolation is needed and `run` is a passthrough.
 *
 * Carrying the principal *grants nothing*. A backend MAY call {@link currentPrincipal} (or
 * {@link tryCurrentPrincipal}) to attribute, branch on, or reject an operation; the default
 * implementations ignore it entirely. Policy is the service's concern — this is only the wire.
 */
export interface PrincipalCarrier {
  /** The principal in force for the current async flow. Throws if none is established. */
  current(): Principal;
  /** The principal in force, or `undefined` when called outside any established scope. */
  tryCurrent(): Principal | undefined;
  /**
   * Establish `principal` for the dynamic extent of `fn` and return whatever `fn` returns. On node
   * this is per-async-flow (concurrent turns stay isolated); nesting cleanly shadows-and-restores,
   * which is how in-flow delegation works. Consume any async iterable *inside* `fn` — returning an
   * unconsumed iterator drops the scope before it is pulled.
   */
  run<T>(principal: Principal, fn: () => T): T;
  /**
   * Imperatively establish `principal` for the remainder of the current flow — for a process or
   * request *entry* that has no wrapping `fn` (a spawned worker reading its delegated identity, a
   * boot default). Throws if a principal is already established here: re-entry is a wiring bug, and
   * legitimate delegation belongs in a nested {@link run} or at a fresh process boundary.
   */
  enter(principal: Principal): void;
}

let carrier: PrincipalCarrier | undefined;

/** Install the host's platform carrier. Called once at boot, before any turn or request runs. */
export function installPrincipalCarrier(impl: PrincipalCarrier): void {
  carrier = impl;
}

function need(): PrincipalCarrier {
  if (carrier === undefined) {
    throw new Error('No PrincipalCarrier installed — the host must call installPrincipalCarrier() at boot.');
  }
  return carrier;
}

/** The principal in force for the current flow. Throws if called with no carrier or no scope. */
export function currentPrincipal(): Principal {
  return need().current();
}

/** The principal in force, or `undefined` when no carrier is installed or no scope is established.
 *  Backends that want to fail-open on out-of-scope access read this instead of {@link currentPrincipal}. */
export function tryCurrentPrincipal(): Principal | undefined {
  return carrier?.tryCurrent();
}

/** Run `fn` with `principal` established as the ambient identity for its async extent. */
export function runAs<T>(principal: Principal, fn: () => T): T {
  return need().run(principal, fn);
}

/** Imperatively establish `principal` for the current flow (entry points only). */
export function enterPrincipal(principal: Principal): void {
  need().enter(principal);
}

/**
 * A carrier for single-principal realms (the browser, tests): every read returns the same
 * `principal` and `run` is a passthrough, since there is no second identity to isolate from.
 */
export function createConstantPrincipalCarrier(principal: Principal): PrincipalCarrier {
  return {
    current:    () => principal,
    tryCurrent: () => principal,
    run:        (_principal, fn) => fn(),
    enter:      () => {},
  };
}
