// ── Vault ─────────────────────────────────────────────────────────────────────

/**
 * The primitives a vault backend must implement. Redaction, and the low-level store operations the
 * `resolve` and `createSecret` policies compose. A backend implements `Vault` (which is `VaultSpec`
 * plus those policies); plugins are handed a `Vault`.
 */
export interface VaultSpec {
  /**
   * The value stored under exactly `name`, or `undefined`. The literal read, as `writeSecret` is the
   * literal write: a name is a name, with no placeholder syntax, so a caller holding one never encodes
   * it into a `${NAME}` for `resolve` to parse back out — `A}${B` is simply absent, not two lookups.
   */
  readSecret(name: string): Promise<string | undefined>;
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
  /**
   * Why this backend cannot store a secret under `name` — `undefined` when it can. What is storable
   * is the *backend's* business: an in-memory map takes anything referenceable, a `.env`-backed one
   * takes environment-variable names, a header-based one may exclude `:`.
   *
   * The returned string is the RULE, phrased for whoever must now choose another name (often an LLM
   * that invented the rejected one), not a restatement of the failure — it is the only place that
   * knowledge exists, and it is what rides on the thrown {@link InvalidSecretNameError}. Enforced by
   * `assertStorableKey`, which every backend's `writeSecret` calls before storing; a backend omitting
   * this method accepts any name.
   */
  unstorableKey?(name: string): string | undefined;
}

export interface Vault extends VaultSpec {
  /**
   * Expand every `${NAME}` placeholder in `ref` with its stored value; throws `MissingSecretError`
   * naming every miss. A backend's is `applyResolve(this, ref)`.
   */
  resolve(ref: string): Promise<string>;
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
