import { watch, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

function mdNameToSkillName(filename: string): string {
  return path.basename(filename, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function importFile(
  store:  Store<SkillDoc>,
  skills: Map<string, SkillDoc>,
  dir:    string,
  filename: string,
): Promise<void> {
  const name = mdNameToSkillName(filename);
  const key  = name.toLowerCase();
  // .md files are import-only: once a skill exists in the store, the store owns it.
  if (skills.has(key)) return;

  const content = await readFile(path.join(dir, filename), 'utf8').catch(() => null);
  if (content === null) return;

  const now = new Date().toISOString();
  const doc: SkillDoc = {
    id:        crypto.randomUUID(),
    version:   Date.now().toString(),
    name,
    content,
    contexts:  ['global'],
    createdAt: now,
    updatedAt: now,
  };

  await store.set(doc.id, doc);
  skills.set(key, doc);
}

/**
 * Imports all .md files from `dir` into the store, then watches for new or
 * changed files and imports them on arrival. Falls back to polling if watch
 * is unavailable.
 */
export async function watchAndImportSkillDir(
  dir:    string,
  store:  Store<SkillDoc>,
  skills: Map<string, SkillDoc>,
  signal: AbortSignal,
  pollMs = 5_000,
): Promise<void> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return; }
  for (const f of files) {
    if (f.endsWith('.md')) await importFile(store, skills, dir, f);
  }

  try {
    for await (const event of watch(dir, { signal })) {
      if (!event.filename?.endsWith('.md')) continue;
      await importFile(store, skills, dir, event.filename);
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
        if (f.endsWith('.md')) await importFile(store, skills, dir, f);
      }
    }
  }
}
