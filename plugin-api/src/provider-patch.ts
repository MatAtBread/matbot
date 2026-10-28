import type { ProviderConfig } from './types.js';
import type { ProviderPatch } from './types/builtin-tools.js';
import type { VaultSpec } from './types/vault.js';

/** The vault key a profile's own credential is stored under by default: `MATBOT_API_KEY_<PROFILE>`. */
export function credentialKeyName(profile: string): string {
  return `MATBOT_API_KEY_${profile.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * The `provider update` policy, written once so every implementer of it behaves identically — the same
 * reasoning as `applyCreateSecret` in `vault.ts`. Two hosts apply this patch (the node `provider` tool
 * against matbot.yaml, the browser bootstrap against its persisted map) and the *semantics* of a patch
 * must not be one of the things they differ on: `null` clears a field, absent leaves it alone.
 *
 * `parameters` is replaced wholesale rather than merged per key. Its values are forwarded to the
 * endpoint unmodified and so have no shape to merge against — and `provider list` reports them in full,
 * which is what makes a read-modify-write something a caller can actually carry out. (Contrast
 * `default_settings`, which merges per key: there the keys are matbot's own.)
 *
 * `credentials` and `module` are absent from `ProviderPatch`; see that type for why neither belongs in an
 * update. `module` rides through untouched. `credentials` does too — unless the endpoint now names another
 * ORIGIN (scheme, host and port; clearing it back to the adapter's default counts), because the credential
 * is sent wherever the endpoint points: an endpoint change was a way to post the key to any host at all,
 * with the update's own prompt never mentioning it. So the profile is pointed at fresh vault keys instead,
 * none of which exists yet, and whoever means it to have a credential there supplies one out of band
 * (`plugin store-key`). The old keys stay in the vault, since another profile may share them.
 * {@link movedCredentialKeys} names the new ones.
 */
export function applyProviderPatch(cur: ProviderConfig, patch: ProviderPatch, vault: Pick<VaultSpec, 'hasKey'>): ProviderConfig {
  const next: ProviderConfig = { ...cur };
  // Spelled out per field rather than looped: `exactOptionalPropertyTypes` makes "assign, or delete if
  // null" a different statement for each type, and a loop only reaches them through a cast that would
  // stop the compiler checking the one thing worth checking here.
  if (patch.model      !== undefined) next.model = patch.model;
  if (patch.endpoint   !== undefined) { if (patch.endpoint   === null) delete next.endpoint;   else next.endpoint   = patch.endpoint;   }
  if (patch.parameters !== undefined) { if (patch.parameters === null) delete next.parameters; else next.parameters = patch.parameters; }
  if (patch.maxRounds  !== undefined) { if (patch.maxRounds  === null) delete next.maxRounds;  else next.maxRounds  = patch.maxRounds;  }
  if (cur.credentials !== undefined && originOf(cur.endpoint) !== originOf(next.endpoint)) {
    const base = credentialKeyName(cur.name);
    const taken = new Set<string>();
    const fresh: Record<string, string> = {};
    for (const field of Object.keys(cur.credentials)) {
      const stem = field === 'apiKey' ? base : `${base}_${field.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      let key = stem;
      for (let n = 2; vault.hasKey(key) || taken.has(key); n++) key = `${stem}_${n}`;
      taken.add(key);
      fresh[field] = `\${${key}}`;
    }
    next.credentials = fresh;
  }
  return next;
}

/** The vault keys a patched profile now reads its credential from, where {@link applyProviderPatch} took
 *  it off because the endpoint moved origin; empty when it did not. */
export function movedCredentialKeys(cur: ProviderConfig, next: ProviderConfig): readonly string[] {
  if (cur.credentials === next.credentials || next.credentials === undefined) return [];
  return Object.values(next.credentials).map(v => v.slice(2, -1));
}

// An endpoint that is not a URL is compared as written: nothing can say it is the same place.
function originOf(endpoint: string | undefined): string | undefined {
  return endpoint !== undefined && URL.canParse(endpoint) ? new URL(endpoint).origin : endpoint;
}

/** The fields a patch actually changes, in a stable order — for a confirmation prompt or a result message. */
export function patchedFields(patch: ProviderPatch): readonly ('model' | 'endpoint' | 'parameters' | 'maxRounds')[] {
  return (['model', 'endpoint', 'parameters', 'maxRounds'] as const).filter(f => patch[f] !== undefined);
}
