import type { VaultSpec } from './types.js';
import { invalidSecretNameError } from './errors.js';

/**
 * The rule every vault shares, whatever else it adds: a secret is only reachable through a
 * `${NAME}` placeholder, so a name carrying whitespace, `$`, `{` or `}` — or no characters at all —
 * can be written and never read back. Backends narrow this (see `EnvFileVault`); none widen it.
 */
export const REFERENCEABLE_KEY_RULE =
  'a secret name must be non-empty and contain no whitespace, `$`, `{` or `}`, so that it can be referenced as ${NAME}';

/** The shared base policy, for a backend whose `unstorableKey` adds nothing of its own. */
export function unreferenceableKey(name: string): string | undefined {
  return /^[^\s${}]+$/.test(name) ? undefined : REFERENCEABLE_KEY_RULE;
}

/**
 * Refuse a name the backend cannot store, rather than writing something that silently disappears —
 * the `.env` line systemd discards, the header a proxy strips. Called by every backend's
 * `writeSecret` before it stores, which is the one point that still knows the requested name:
 * `createSecret` may canonicalise it away, and by the time a reader misses the secret there is
 * nothing left to blame.
 *
 * Removal (`writeSecret(name, '')`) deliberately does not go through here — a name that became
 * unstorable, or arrived from an environment snapshot that never passed the policy, must still be
 * deletable.
 */
export function assertStorableKey(spec: VaultSpec, name: string): void {
  const rule = spec.unstorableKey?.(name);
  if (rule !== undefined) throw invalidSecretNameError(name, rule);
}

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
