import type { Vault } from '@matatbread/matbot-core';

const ENV_RE    = /\$\{env:([^}]+)\}/g;
const SECRET_RE = /\$\{secret:([^}]+)\}/g;

/**
 * Default vault implementation.
 *
 * Resolves ${env:NAME} by looking up the exact env-var name.
 * Resolves ${secret:name} from the secrets store (pre-populated from MATBOT_SECRET_* env vars).
 * createSecret(name, value) makes a value immediately available to both resolution forms
 * and visible to scrub().
 *
 * The caller is responsible for loading any backing store (e.g. .env file) into the
 * env snapshot passed to the constructor before constructing this instance.
 * Persistence beyond the current process is a plugin concern.
 */
export class VaultImpl implements Vault {
  // Keyed by exact env-var name — used for ${env:NAME} resolution.
  private readonly rawEnv = new Map<string, string>();

  // Keyed by secret name (may be transformed) — used for ${secret:name} resolution and scrub.
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
      const PREFIX = 'MATBOT_SECRET_';
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        this.rawEnv.set(k, v);
        if (k.startsWith(PREFIX)) {
          const name = k.slice(PREFIX.length).toLowerCase().replace(/_/g, '-');
          if (!this.store.has(name)) this.store.set(name, v);
        } else if (!this.store.has(k)) {
          this.store.set(k, v);
        }
      }
    }
  }

  async createSecret(name: string, value: string): Promise<void> {
    this.rawEnv.set(name, value);
    this.store.set(name, value);
  }

  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];

    let result = ref.replace(ENV_RE, (_, name: string) => {
      const value = this.rawEnv.get(name);
      if (value === undefined) { errors.push(`env:${name}`); return ''; }
      return value;
    });

    result = result.replace(SECRET_RE, (_, name: string) => {
      const value = this.store.get(name);
      if (value === undefined) { errors.push(name); return ''; }
      return value;
    });

    if (errors.length > 0) {
      throw new Error(`Vault: secret(s) not found: ${errors.join(', ')}`);
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
