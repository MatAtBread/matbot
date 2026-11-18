import { access } from 'node:fs/promises';
import path       from 'node:path';

export async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

/** Extra `add` flags needed to install into `dir` itself.
 *
 *  `pnpm add` refuses at a workspace root (ERR_PNPM_ADDING_TO_ROOT) unless the root is named
 *  explicitly, on the assumption that a member package was meant. Here it never was: `dir` is where
 *  matbot.yaml lives, and a plugin is that project's dependency — there is no member package it could
 *  belong to instead. So say so, rather than failing an install that had nowhere else to go. */
export async function addFlags(pm: string, dir: string): Promise<string[]> {
  if (pm !== 'pnpm') return [];
  try { await access(path.join(dir, 'pnpm-workspace.yaml')); return ['-w']; } catch { return []; }
}
