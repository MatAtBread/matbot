import type { VaultSpec } from './types.js';

/**
 * The `createSecret` policy, written once over the spec primitives so every backend behaves
 * identically. A backend's `createSecret` is just `applyCreateSecret(this, name, value)`.
 *
 * The dedup step (returning an existing name for a value already stored) technically lets a
 * caller confirm a name for a value they already hold — but holding the value already grants
 * everything that confirmation would, so it leaks nothing.
 */
export async function applyCreateSecret(
  spec:  VaultSpec,
  name:  string,
  value: string,
): Promise<string> {
  if (spec.hasKey(value)) return value;
  const existing = spec.findByValue?.(value);
  if (existing !== undefined) return existing;
  await spec.writeSecret(name, value);
  return name;
}
