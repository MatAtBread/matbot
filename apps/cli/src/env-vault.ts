import { VaultImpl } from '@matatbread/matbot-core';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * The default node Vault implementation: an in-memory VaultImpl whose writes are persisted to
 * the .env file next to matbot.yaml, so secrets stored at runtime (via the `plugin store-key`
 * tool or CLI bootstrap) survive a restart. Reads still come from the env snapshot loaded into
 * the constructor; this only adds persistence.
 *
 * Persistence hooks the write primitive, not createSecret — so the reference and dedup paths of
 * createSecret (which never call writeSecret) never append a dead line to .env.
 */
export class EnvFileVault extends VaultImpl {
  private readonly envPath: string;

  constructor(envPath: string, env?: Record<string, string | undefined>) {
    super({}, env);
    this.envPath = envPath;
  }

  override async writeSecret(name: string, value: string): Promise<void> {
    await super.writeSecret(name, value);

    let existing = '';
    try { existing = await readFile(this.envPath, 'utf8'); } catch { /* no file yet */ }
    const lines = existing
      ? existing.split('\n').filter(l => l !== '' && !l.startsWith(`${name}=`))
      : [];
    lines.push(`${name}=${value}`);
    await writeFile(this.envPath, lines.join('\n') + '\n', 'utf8');
  }
}
