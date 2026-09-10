import type { ProviderConfig } from './types.js';
import type { ProviderPatch } from './types/builtin-tools.js';

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
 * `credentials` and `module` are absent from `ProviderPatch` and therefore ride through untouched; see
 * that type for why neither belongs in an update.
 */
export function applyProviderPatch(cur: ProviderConfig, patch: ProviderPatch): ProviderConfig {
  const next: ProviderConfig = { ...cur };
  // Spelled out per field rather than looped: `exactOptionalPropertyTypes` makes "assign, or delete if
  // null" a different statement for each type, and a loop only reaches them through a cast that would
  // stop the compiler checking the one thing worth checking here.
  if (patch.model      !== undefined) next.model = patch.model;
  if (patch.endpoint   !== undefined) { if (patch.endpoint   === null) delete next.endpoint;   else next.endpoint   = patch.endpoint;   }
  if (patch.parameters !== undefined) { if (patch.parameters === null) delete next.parameters; else next.parameters = patch.parameters; }
  if (patch.maxRounds  !== undefined) { if (patch.maxRounds  === null) delete next.maxRounds;  else next.maxRounds  = patch.maxRounds;  }
  return next;
}

/** The fields a patch actually changes, in a stable order — for a confirmation prompt or a result message. */
export function patchedFields(patch: ProviderPatch): readonly ('model' | 'endpoint' | 'parameters' | 'maxRounds')[] {
  return (['model', 'endpoint', 'parameters', 'maxRounds'] as const).filter(f => patch[f] !== undefined);
}
