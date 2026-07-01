import type { Store, Vault } from '@matatbread/matbot-core';
import { missingSecretError, applyCreateSecret } from '@matatbread/matbot-core';

const REF_RE  = /\$\{([^}]+)\}/g;
const DOC_ID  = 'secrets';

interface VaultDoc {
  id:      string;
  version: string;
  secrets: Record<string, string>;
}

/**
 * A `Vault` whose secrets persist as a single document in a Drive-backed `Store` (the `vault`
 * namespace of the active StorageBackend — so once the Google Drive backend is registered, secrets
 * live in Drive and follow the user across machines). Secrets are held in memory for synchronous
 * `hasKey`/`findByValue`/`resolve`; every `writeSecret` flushes the whole map back to the store.
 *
 * Stored in plaintext, matching the localStorage vault's posture — adequate for a single-user realm,
 * not for shared storage. (WebCryptoVault's AES-GCM helpers are the eventual upgrade path.)
 */
export class DriveVault implements Vault {
  private readonly store: Store<VaultDoc>;
  private readonly secrets: Map<string, string>;

  private constructor(store: Store<VaultDoc>, doc: VaultDoc | null) {
    this.store   = store;
    this.secrets = new Map(doc ? Object.entries(doc.secrets) : []);
  }

  static async open(store: Store<VaultDoc>): Promise<DriveVault> {
    return new DriveVault(store, await store.get(DOC_ID));
  }

  /** Merge any secrets not already present (e.g. migrating the localStorage vault) and persist once. */
  async seedMissing(secrets: Record<string, string>): Promise<void> {
    let changed = false;
    for (const [k, v] of Object.entries(secrets)) {
      if (!this.secrets.has(k)) { this.secrets.set(k, v); changed = true; }
    }
    if (changed) await this.persist();
  }

  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  async writeSecret(name: string, value: string): Promise<void> {
    if (value === '') {
      if (!this.secrets.delete(name)) return;
    } else {
      this.secrets.set(name, value);
    }
    await this.persist();
  }

  hasKey(name: string): boolean {
    return this.secrets.has(name);
  }

  findByValue(value: string): string | undefined {
    for (const [k, v] of this.secrets) if (v === value) return k;
    return undefined;
  }

  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];
    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.secrets.get(name);
      if (value === undefined) { errors.push(name); return ''; }
      return value;
    });
    if (errors.length > 0) throw missingSecretError(errors);
    return result;
  }

  scrub(text: string): string {
    let result = text;
    for (const value of this.secrets.values()) {
      if (value.length >= 4) result = result.split(value).join('[REDACTED]');
    }
    return result;
  }

  private async persist(): Promise<void> {
    const next: VaultDoc = {
      id:      DOC_ID,
      version: crypto.randomUUID(),
      secrets: Object.fromEntries(this.secrets),
    };
    await this.store.set(DOC_ID, next);
  }
}
