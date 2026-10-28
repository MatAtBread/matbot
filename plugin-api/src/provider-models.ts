import type { ProviderAdapter, ProviderConfig } from './types.js';
import type { Vault } from './types/vault.js';

export const MODEL_LIST_TIMEOUT_MS = 8_000;

export type ModelCheck =
  | { kind: 'listed' }
  | { kind: 'unlisted'; count: number; closest: string[] }
  /** Nothing could be compared: no `models`, a missing key, a refusal, a timeout, an empty list. */
  | { kind: 'unchecked'; reason: string };

/**
 * Whether `model` is one the endpoint lists. Not exact equality, because an endpoint accepts more names
 * than it lists: Anthropic an undated alias of a dated id (`claude-sonnet-4-5` for
 * `claude-sonnet-4-5-20250929`) and a `-latest` one, Ollama a bare name for its `:latest` tag. Gemini's
 * lists say `models/<id>`, which either spelling of the model matches.
 */
export function modelListed(model: string, ids: readonly string[]): boolean {
  const m = model.replace(/^models\//, '');
  return ids.some(raw => {
    const id = raw.replace(/^models\//, '');
    return id === m || id === `${m}:latest`
      || (id.startsWith(`${m}-`) && /^\d{8}$/.test(id.slice(m.length + 1)))
      || (m.endsWith('-latest') && id.startsWith(m.slice(0, -'latest'.length)));
  });
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * The ids nearest `id`, best first. Shared name segments (family, size, quantisation) find a model's
 * siblings from a partial name (`qwen3-4b`, `sonnet-4-6`); a spelling within two edits of an id comes
 * ahead of them all, being what a typo looks like.
 */
export function closestIds(id: string, ids: readonly string[], n = 5): string[] {
  const parts = (s: string): string[] => s.toLowerCase().split(/[-_.:/\s]+/).filter(Boolean);
  const want = parts(id);
  return ids
    .map(candidate => {
      const have  = parts(candidate);
      const score = want.filter(w => have.some(h => h === w)).length * 2
        + want.filter(w => have.some(h => h !== w && (h.includes(w) || w.includes(h)))).length;
      return { id: candidate, score, dist: editDistance(id.toLowerCase(), candidate.toLowerCase()) };
    })
    .filter(x => x.score > 0 || x.dist <= 2)
    .sort((a, b) => Number(a.dist > 2) - Number(b.dist > 2) || b.score - a.score || a.dist - b.dist || a.id.localeCompare(b.id))
    .slice(0, n)
    .map(x => x.id);
}

/**
 * Asks the endpoint which models it serves and compares `config.model` against them, so a typo is caught
 * where it is made rather than as a 404 on the next turn. Listing SENDS the profile's credential, so a
 * caller asks only once that credential may go to `config.endpoint` — the same exposure the profile's
 * own first turn has.
 *
 * Never throws, and `unchecked` is not a failure: most endpoints that cannot list (a gateway, a key not
 * yet stored, a server with no `/models`) still serve the model fine.
 */
export async function checkProviderModel(
  adapter:   Pick<ProviderAdapter, 'models'>,
  config:    ProviderConfig,
  vault:     Pick<Vault, 'resolve'>,
  timeoutMs: number = MODEL_LIST_TIMEOUT_MS,
): Promise<ModelCheck> {
  if (adapter.models === undefined) return { kind: 'unchecked', reason: 'the adapter cannot list its models' };
  let resolved: ProviderConfig;
  try {
    const credentials: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.credentials ?? {})) credentials[k] = await vault.resolve(v);
    resolved = {
      ...config,
      ...(config.credentials !== undefined ? { credentials } : {}),
      ...(config.endpoint    !== undefined ? { endpoint: await vault.resolve(config.endpoint) } : {}),
    };
  } catch (e) {
    return { kind: 'unchecked', reason: e instanceof Error ? e.message : String(e) };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let ids: readonly string[];
  try {
    // Raced as well as signalled: an adapter may ignore the signal, and a hung list must not hold up the tool.
    ids = await Promise.race([
      adapter.models(resolved, signal),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), { once: true })),
    ]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { kind: 'unchecked', reason: why.length > 200 ? `${why.slice(0, 200)}…` : why };
  }
  if (ids.length === 0) return { kind: 'unchecked', reason: 'the endpoint listed no models' };
  if (modelListed(config.model, ids)) return { kind: 'listed' };
  return { kind: 'unlisted', count: ids.length, closest: closestIds(config.model, ids) };
}
