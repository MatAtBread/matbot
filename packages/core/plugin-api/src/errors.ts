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

/**
 * Thrown by a `PromptFn` implementation when the user cancels — the "give up" path, not a graceful
 * decline. Callers awaiting `ctx.prompt()` need not branch on it: the surrounding try/catch turns
 * it into a tool error that closes the tool call, while the host separately abandons the turn.
 */
export class PromptCancelledError extends Error {
  constructor(message = 'User cancelled — cannot proceed.') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}
