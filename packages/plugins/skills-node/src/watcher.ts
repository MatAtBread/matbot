import { watch, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillManager } from '@matatbread/matbot-skills';

function mdNameToSkillName(filename: string): string {
  return path.basename(filename, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function importFile(
  manager:  SkillManager,
  dir:      string,
  filename: string,
): Promise<void> {
  const name = mdNameToSkillName(filename);
  // .md files are import-only: once a skill exists, the store owns it (skip the read entirely).
  if (manager.get(name) !== undefined) return;

  const content = await readFile(path.join(dir, filename), 'utf8').catch(() => null);
  if (content === null) return;

  await manager.importIfAbsent(name, content);
}

/**
 * Imports all .md files from `dir` into the skill set, then watches for new or changed files
 * and imports them on arrival. Falls back to polling if watch is unavailable. Node-only — this
 * is the filesystem capability the cross-runtime base plugin deliberately omits.
 */
export async function watchAndImportSkillDir(
  dir:     string,
  manager: SkillManager,
  signal:  AbortSignal,
  pollMs = 5_000,
): Promise<void> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return; }
  for (const f of files) {
    if (f.endsWith('.md')) await importFile(manager, dir, f);
  }

  try {
    for await (const event of watch(dir, { signal })) {
      if (!event.filename?.endsWith('.md')) continue;
      await importFile(manager, dir, event.filename);
    }
  } catch {
    if (signal.aborted) return;
    while (!signal.aborted) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, pollMs);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      let polled: string[] = [];
      try { polled = await readdir(dir); } catch { return; }
      for (const f of polled) {
        if (f.endsWith('.md')) await importFile(manager, dir, f);
      }
    }
  }
}
