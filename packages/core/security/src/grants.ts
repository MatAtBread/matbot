import type { CapabilityGrant, CapabilityKind, Principal } from '@matatbread/matbot-core';

/** Convenience: build a Principal with all capabilities (for system use only). */
export function systemPrincipal(id = 'system'): Principal {
  const allCaps: CapabilityKind[] = [
    'network', 'filesystem', 'spawn', 'container', 'audit:read',
  ];
  return {
    id,
    type:     'system',
    grants:   allCaps.map(capability => ({ capability } satisfies CapabilityGrant)),
    contexts: ['global'],
  };
}
