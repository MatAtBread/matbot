import type { Vault } from '@matatbread/matbot-core';

const REF_RE = /\$\{secret:([^}]+)\}/g;

/**
 * Resolves `${secret:name}` placeholders.
 *
 * Resolution order (highest to lowest):
 *   1. Secrets map passed to the constructor
 *   2. Environment map (pass `process.env` on Node) keyed as `MATBOT_SECRET_<NAME>`
 *   3. Environment map keyed by the exact name
 *
 * `scrub` redacts resolved secret values, replacing occurrences with `[REDACTED]`.
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
      const PREFIX = 'MATBOT_SECRET_';
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        if (k.startsWith(PREFIX)) {
          const name = k.slice(PREFIX.length).toLowerCase().replace(/_/g, '-');
          if (!this.store.has(name)) this.store.set(name, v);
        } else if (!this.store.has(k)) {
          this.store.set(k, v);
        }
      }
    }
  }

  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];
    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.store.get(name);
      if (value === undefined) {
        errors.push(name);
        return '';
      }
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
