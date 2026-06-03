import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, parseYaml } from '@matatbread/matbot-config';
import type { MatbotConfig } from '@matatbread/matbot-config';

export type { MatbotConfig };

async function loadBase(
  text:    string,
  fromDir: string,
): Promise<{ baseText: string | undefined; projectDir: string }> {
  const doc = parseYaml(text);
  const ext = doc['extends'];
  if (typeof ext !== 'string') return { baseText: undefined, projectDir: fromDir };
  const basePath = path.resolve(fromDir, ext);
  const baseText = await readFile(basePath, 'utf8');
  return { baseText, projectDir: path.dirname(basePath) };
}

export async function loadConfig(
  configPath: string,
): Promise<{ config: MatbotConfig; projectDir: string }> {
  const text    = await readFile(configPath, 'utf8');
  const fromDir = path.dirname(configPath);
  const { baseText, projectDir } = await loadBase(text, fromDir);
  return { config: parseConfig(text, baseText), projectDir };
}

export async function loadConfigFromText(
  text:    string,
  fromDir: string = process.cwd(),
): Promise<{ config: MatbotConfig; projectDir: string }> {
  const { baseText, projectDir } = await loadBase(text, fromDir);
  return { config: parseConfig(text, baseText), projectDir };
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
