import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, parseYaml } from '@matatbread/matbot-core';
import type { MatbotConfig } from '@matatbread/matbot-core';

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

/** matbot's own settings that are read from the environment, and so may come from `.env` too. Everything
 *  else in `.env` is the vault's, and never reaches `process.env` (see {@link withholdDotEnv}). */
const CONFIG_VARS = new Set(['MATBOT_WEB_PORT', 'MATBOT_PRINCIPAL']);

export async function readDotEnv(dir: string): Promise<Record<string, string>> {
  try { return parseDotEnv(await readFile(path.join(dir, '.env'), 'utf8')); } catch { return {}; }
}

/** Apply the matbot settings a `.env` carries, where the environment does not already say otherwise. The
 *  secrets beside them are read into the vault, not here. */
export async function loadDotEnv(dir: string): Promise<void> {
  for (const [key, value] of Object.entries(await readDotEnv(dir))) {
    if (CONFIG_VARS.has(key) && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * Take `.env`'s keys back out of `process.env`, once the vault holds them. Every process matbot starts
 * inherits `process.env` — `bash`, an MCP server, `npm` installing a fetched plugin's dependencies and
 * running their install scripts — so a secret left there is handed to all of them, and the vault's gates
 * are not asked. They were copied in by matbot itself, and are put there by whatever starts it too (a
 * systemd `EnvironmentFile=`), which is why this removes rather than merely not copying. A secret exported
 * in the environment under a name `.env` does not use is not matbot's to know about, and stays.
 */
export function withholdDotEnv(dotEnv: Record<string, string>): void {
  for (const key of Object.keys(dotEnv)) if (!CONFIG_VARS.has(key)) delete process.env[key];
}
