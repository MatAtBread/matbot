// ── Vault ─────────────────────────────────────────────────────────────────────

/**
 * The primitives a vault backend must implement. Resolution, redaction, and the three
 * low-level store operations the smart `createSecret` policy composes. A backend implements
 * `Vault` (which is `VaultSpec` plus that policy); plugins are handed a `Vault`.
 */
export interface VaultSpec {
  /** Resolve ${NAME} placeholders by looking up the named value; throws MissingSecretError for any miss. */
  resolve(ref: string): Promise<string>;
  scrub(text: string): string;
  /**
   * Store `value` under exactly `name`, overwriting. The literal write; no reference/dedup logic.
   * An empty `value` removes the key instead — there is no such thing as an empty secret, so the
   * empty string is the removal signal (idempotent: removing an absent name is a no-op).
   */
  writeSecret(name: string, value: string): Promise<void>;
  /** Whether a secret is stored under this exact name. */
  hasKey(name: string): boolean;
  /**
   * The name a value is already stored under, if any. Optional: backends that can't (or won't)
   * reverse-index omit it, and `createSecret`'s dedup step is skipped.
   */
  findByValue?(value: string): string | undefined;
}

export interface Vault extends VaultSpec {
  /**
   * Store a secret coming (often) from a user via the LLM, where we cannot tell a real value
   * from a key name they typed by mistake. Returns the key name callers MUST reference — not
   * necessarily the `name` requested:
   *   - `value` is already a known key name → returns `value` (it was a reference, not a secret)
   *   - `value` already stored under another name → returns that name (dedup)
   *   - otherwise → writes under `name` and returns `name`
   */
  createSecret(name: string, value: string): Promise<string>;
}
