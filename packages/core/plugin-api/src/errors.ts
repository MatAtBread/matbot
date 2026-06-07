/**
 * Thrown by Vault.resolve() when one or more ${NAME} placeholders cannot be resolved.
 * `missingKeys` carries the unresolved key names (e.g. `ANTHROPIC_API_KEY`) so callers
 * can prompt for and store them.
 */
export class MissingSecretError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super(`Vault: secret(s) not found: ${missingKeys.join(', ')}`);
    this.name        = 'MissingSecretError';
    this.missingKeys = missingKeys;
  }
}
