import type { Principal } from '@matatbread/matbot-plugin-api';

/** Convenience: the system principal — the origin for operations not driven by an external user. */
export function systemPrincipal(id = 'system'): Principal {
  return { id, type: 'system' };
}
