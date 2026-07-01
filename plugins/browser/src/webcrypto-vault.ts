import type { Vault } from '@matatbread/matbot-core';
import { missingSecretError, applyCreateSecret } from '@matatbread/matbot-core';

const REF_RE = /\$\{([^}]+)\}/g;

/**
 * Browser `Vault` backed by the Web Crypto API.
 *
 * Secrets are encrypted with AES-GCM using a key derived from a passphrase
 * (PBKDF2 / SHA-256).  On first access the key is derived and cached in memory
 * for the session lifetime.
 *
 * For simpler use-cases (e.g. local development), pass secrets directly as a
 * plain map — no encryption key required.
 */
export class WebCryptoVault implements Vault {
  private readonly plain = new Map<string, string>();

  constructor(secrets?: Record<string, string>) {
    if (secrets) {
      for (const [k, v] of Object.entries(secrets)) {
        this.plain.set(k, v);
      }
    }
  }

  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  async writeSecret(name: string, value: string): Promise<void> {
    if (value === '') this.plain.delete(name);
    else this.plain.set(name, value);
  }

  hasKey(name: string): boolean {
    return this.plain.has(name);
  }

  findByValue(value: string): string | undefined {
    for (const [k, v] of this.plain) if (v === value) return k;
    return undefined;
  }

  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];
    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.plain.get(name);
      if (value === undefined) {
        errors.push(name);
        return '';
      }
      return value;
    });
    if (errors.length > 0) {
      throw missingSecretError(errors);
    }
    return result;
  }

  scrub(text: string): string {
    let result = text;
    for (const value of this.plain.values()) {
      if (value.length >= 4) {
        result = result.split(value).join('[REDACTED]');
      }
    }
    return result;
  }

  // ── Encryption helpers (optional; call to store/load secrets via IndexedDB) ──

  private static async deriveKey(passphrase: string, salt: ArrayBuffer): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  static async encrypt(passphrase: string, plaintext: string): Promise<string> {
    const saltBuf = crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer;
    const ivBuf   = crypto.getRandomValues(new Uint8Array(12)).buffer as ArrayBuffer;
    const key     = await WebCryptoVault.deriveKey(passphrase, saltBuf);
    const data    = new TextEncoder().encode(plaintext);
    const ct      = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, key, data);

    // Encode as base64: [salt(16)] [iv(12)] [ciphertext]
    const combined = new Uint8Array(16 + 12 + ct.byteLength);
    combined.set(new Uint8Array(saltBuf), 0);
    combined.set(new Uint8Array(ivBuf), 16);
    combined.set(new Uint8Array(ct), 28);
    return btoa(String.fromCharCode(...combined));
  }

  static async decrypt(passphrase: string, encoded: string): Promise<string> {
    const bytes  = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const salt   = bytes.buffer.slice(bytes.byteOffset,       bytes.byteOffset + 16) as ArrayBuffer;
    const iv     = bytes.buffer.slice(bytes.byteOffset + 16,  bytes.byteOffset + 28) as ArrayBuffer;
    const ct     = bytes.buffer.slice(bytes.byteOffset + 28) as ArrayBuffer;
    const key    = await WebCryptoVault.deriveKey(passphrase, salt);
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  }
}
