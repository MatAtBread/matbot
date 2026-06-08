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
 * Thrown by the loader when an explicit, single, user-initiated load (the `plugin`/`provider`
 * tools via `services.loadPlugin`) targets a plugin whose `matbotRuntime` excludes this host.
 * Unlike a setup() failure — which may be transient (a missing secret) and is left in config to
 * fix — this is permanent for the host, so the `add` flow catches it specifically and rolls the
 * specifier back out of matbot.yaml rather than persisting a plugin that can never activate here.
 */
export class IncompatibleRuntimeError extends Error {
  readonly specifier:    string;
  readonly declared:     readonly string[];
  readonly hostRuntime:  string;

  constructor(specifier: string, declared: readonly string[], hostRuntime: string) {
    super(`Cannot load plugin "${specifier}": declares matbotRuntime [${declared.join(', ')}], host runtime is "${hostRuntime}".`);
    this.name        = 'IncompatibleRuntimeError';
    this.specifier   = specifier;
    this.declared    = declared;
    this.hostRuntime = hostRuntime;
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
