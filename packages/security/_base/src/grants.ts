import type { CapabilityGrant, CapabilityKind, Principal } from '@matbot/core';

/**
 * Returns true when `principal` holds a grant for every capability in
 * `required`.  An optional `scope` on the grant further restricts the match:
 * if the grant has a scope, the requested scope must start with it.
 */
export function hasGrant(
  principal: Principal,
  capability: CapabilityKind,
  scope?: string,
): boolean {
  return principal.grants.some(g => {
    if (g.capability !== capability) return false;
    if (g.scope === undefined) return true;
    if (scope === undefined) return false;
    return scope.startsWith(g.scope);
  });
}

export function checkGrants(
  principal: Principal,
  required:  readonly CapabilityKind[],
  scope?:    string,
): void {
  const missing = required.filter(cap => !hasGrant(principal, cap, scope));
  if (missing.length > 0) {
    throw new Error(`Principal "${principal.id}" lacks capabilities: ${missing.join(', ')}`);
  }
}

/** Convenience: build a Principal with all capabilities (for system use only). */
export function systemPrincipal(id = 'system'): Principal {
  const allCaps: CapabilityKind[] = [
    'network', 'filesystem', 'spawn', 'container',
    'memory:read', 'memory:write', 'audit:read',
  ];
  return {
    id,
    type:     'system',
    grants:   allCaps.map(capability => ({ capability } satisfies CapabilityGrant)),
    contexts: ['global'],
  };
}
