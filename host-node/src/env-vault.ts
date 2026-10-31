import { VaultImpl } from '@matatbread/matbot-core';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * A vault persisted to an environment file (`NAME=value` lines): secrets stored at runtime survive a
 * restart. The values are plaintext, readable by anything that can read the file — a shell tool included.
 *
 * It reads and writes its own file, so the two cannot disagree about the format: a value is written in the
 * form {@link parseEnvFile} reads back unchanged, quoted where it would otherwise be reinterpreted (a ` #`
 * read as a comment, surrounding quotes or whitespace stripped), and one it cannot represent (a line break)
 * is refused rather than written broken.
 *
 * Persistence hooks the write primitive, not createSecret — so the reference and dedup paths of
 * createSecret (which never call writeSecret) never append a dead line to the file.
 *
 * The file may also be read as an environment file by whatever starts the process (a systemd
 * `EnvironmentFile=`), so the name policy is narrower than the base vault's: anything else is written,
 * accepted, and then dropped by such a reader with at most a log line nobody sees.
 */
export class EnvFileVault extends VaultImpl {
  private readonly envPath: string;

  /** The vault over `envPath`, holding what the file holds; `env` (say `process.env`) wins over it. */
  static async open(envPath: string, env?: Record<string, string | undefined>): Promise<EnvFileVault> {
    return new EnvFileVault(envPath, { ...await readEnvFile(envPath), ...env });
  }

  /** Over `envPath`, holding exactly `env`: the file is written to, never read. {@link open} reads it. */
  constructor(envPath: string, env?: Record<string, string | undefined>) {
    super({}, env);
    this.envPath = envPath;
  }

  override unstorableKey(name: string): string | undefined {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      ? undefined
      : 'this vault persists to a .env file, so a secret name must be a valid environment-variable name: a letter or underscore, then letters, digits or underscores only (e.g. ACME_EMAIL_PASSWORD)';
  }

  override async writeSecret(name: string, value: string): Promise<void> {
    if (/[\r\n]/.test(value)) throw new Error(`Secret "${name}" contains a line break, which a .env file cannot hold`);
    await super.writeSecret(name, value);

    let existing = '';
    try { existing = await readFile(this.envPath, 'utf8'); } catch { /* no file yet */ }
    const lines = existing
      ? existing.split('\n').filter(l => l !== '' && !l.startsWith(`${name}=`))
      : [];
    if (value !== '') lines.push(`${name}=${envValue(value)}`);
    await writeFile(this.envPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  }
}

// Bare where the reader would return it unchanged; otherwise quoted, which the reader strips and nothing else.
function envValue(value: string): string {
  const bare = value === value.trim() && !/\s#/.test(value) && !/^(["']).*\1$/s.test(value);
  if (bare) return value;
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/** The `NAME=value` lines of an environment file: `#` comments, an optional `export `, and a value either
 *  quoted (the quotes stripped) or bare (a trailing ` # comment` and surrounding whitespace dropped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trimEnd();
    if (!key) continue;
    let val = stripped.slice(eq + 1);
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.search(/\s+#/);
      if (commentIdx !== -1) val = val.slice(0, commentIdx);
      val = val.trim();
    }
    out[key] = val;
  }
  return out;
}

/** {@link parseEnvFile} of the file at `envPath`; an absent or unreadable file holds nothing. */
export async function readEnvFile(envPath: string): Promise<Record<string, string>> {
  try { return parseEnvFile(await readFile(envPath, 'utf8')); } catch { return {}; }
}
