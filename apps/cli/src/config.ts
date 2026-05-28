import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig } from '@matatbread/matbot-config';
import type { MatbotConfig } from '@matatbread/matbot-config';

export type { MatbotConfig };

export async function loadConfig(
  configPath: string,
  env: Record<string, string | undefined> = {},
): Promise<MatbotConfig> {
  const text = await readFile(configPath, 'utf8');
  return parseConfig(text, env);
}

function parseDotEnv(text: string): Record<string, string> {
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
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
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

export async function loadDotEnv(dir: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path.join(dir, '.env'), 'utf8');
  } catch {
    return new Set();
  }
  const applied = new Set<string>();
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (!(key in process.env)) {
      process.env[key] = value;
      applied.add(key);
    }
  }
  return applied;
}
