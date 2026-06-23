import type { Vault } from '@matatbread/matbot-core';
import { WebCryptoVault } from './webcrypto-vault.js';

const STORAGE_KEY = 'matbot.vault';

function load(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

/**
 * A browser `Vault` whose secrets persist in `localStorage`, so an API key entered once survives a
 * realm reload. It is a thin durability layer over {@link WebCryptoVault} (which holds secrets in
 * memory and does the `${NAME}` resolution and scrubbing); every write is mirrored to storage.
 *
 * Secrets are stored in plaintext under one key — acceptable for a single-user local demonstrator,
 * not for shared machines. `WebCryptoVault`'s static AES-GCM helpers are the upgrade path.
 */
export class LocalStorageVault extends WebCryptoVault implements Vault {
  // The base keeps secrets in a private map; we keep a parallel mirror purely to persist it.
  private readonly mirror: Record<string, string>;

  constructor() {
    const seed = load();
    super(seed);
    this.mirror = { ...seed };
  }

  override async writeSecret(name: string, value: string): Promise<void> {
    await super.writeSecret(name, value);
    this.mirror[name] = value;
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.mirror)); } catch { /* storage full / unavailable */ }
  }
}
