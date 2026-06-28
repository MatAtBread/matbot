import type { Vault } from '@matatbread/matbot-plugin-api';
import { missingSecretError, applyCreateSecret } from '@matatbread/matbot-plugin-api';

const REF_RE = /\$\{([^}]+)\}/g;

/**
 * Default vault implementation: a single flat namespace of secrets keyed by name.
 *
 * Resolves ${NAME} placeholders by looking up `NAME`. There is no env/secret distinction —
 * an env var is simply a secret whose name happens to be its env-var name. A backend may
 * privately treat some prefixes specially, but the placeholder syntax and this interface do not.
 *
 * The caller loads any backing store (e.g. a .env file) into the snapshot passed to the
 * constructor; persistence beyond the current process is a subclass concern (see EnvFileVault).
 */
export class VaultImpl implements Vault {
  private readonly store = new Map<string, string>();

  constructor(
    secrets?: Record<string, string>,
    env?:     Record<string, string | undefined>,
  ) {
    if (secrets) {
      for (const [k, v] of Object.entries(secrets)) {
        this.store.set(k, v);
      }
    }
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && !this.store.has(k)) this.store.set(k, v);
      }
    }
  }

  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  async writeSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }

  hasKey(name: string): boolean {
    return this.store.has(name);
  }

  findByValue(value: string): string | undefined {
    for (const [k, v] of this.store) if (v === value) return k;
    return undefined;
  }

  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];

    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.store.get(name);
      if (value === undefined) { errors.push(name); return ''; }
      return value;
    });

    if (errors.length > 0) {
      throw missingSecretError(errors);
    }
    return result;
  }

  scrub(text: string): string {
    let result = text;
    for (const value of this.store.values()) {
      if (value.length >= 4) {
        result = result.split(value).join('[REDACTED]');
      }
    }
    return result;
  }
}
