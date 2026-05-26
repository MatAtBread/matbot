import { readFile } from 'node:fs/promises';
import path from 'node:path';

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Strip optional 'export ' prefix
    const stripped = line.startsWith('export ') ? line.slice(7).trimStart() : line;

    const eq = stripped.indexOf('=');
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trimEnd();
    if (!key) continue;

    let val = stripped.slice(eq + 1);

    // Single or double quoted value — take content as-is, no comment stripping
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip inline comment from unquoted value
      const commentIdx = val.search(/\s+#/);
      if (commentIdx !== -1) val = val.slice(0, commentIdx);
      val = val.trim();
    }

    out[key] = val;
  }

  return out;
}

/**
 * Load a `.env` file from `dir`, parse it, and write any key that is not
 * already present in `process.env`.  Silently does nothing if the file does
 * not exist.
 *
 * Returns the set of keys that were actually applied (useful for diagnostics).
 */
export async function loadDotEnv(dir: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path.join(dir, '.env'), 'utf8');
  } catch {
    return new Set();
  }

  const applied = new Set<string>();
  for (const [key, value] of Object.entries(parse(text))) {
    if (!(key in process.env)) {
      process.env[key] = value;
      applied.add(key);
    }
  }
  return applied;
}
