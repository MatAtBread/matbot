/*
 * ⚠️  DELIBERATELY-KEPT EXAMPLE — NOT REQUIRED INFRASTRUCTURE, AND NOT THE PATTERN TO COPY.  ⚠️
 *
 * This file does two separable things:
 *   (1) transform author-dropped `.md` files into skill-store entries (a genuine ingestion feature), and
 *   (2) WATCH the directory (node:fs `watch`, polling fallback) so edits import live.
 *
 * Part (2) is the outlier — the reason this plugin gets singled out. Note the default `skillsDir` is
 * `.data/skills`: it runs `node:fs.watch` straight on the SKILL STORE'S OWN BACKING DIRECTORY, reaching
 * around the `Store` / `StorageBackend` abstraction to touch the filesystem the backend happens to use.
 * That is the exact abstraction-violation the read-through refactor removed one level up: SkillManager and
 * TriggerManager used to keep in-memory snapshots of their store and serve reads from them; those were
 * deleted in favour of reading straight through the swap-following store proxy. This is the *filesystem*
 * twin of that same mistake — a consumer caching/watching the backend's private storage instead of going
 * through the interface. The lesson is identical at both levels:
 *
 *     WATCHING (or caching) STORAGE FOR CHANGES IS A BACKEND CONCERN, NOT A CONSUMER'S.
 *
 * A consumer must not know the active backend is a filesystem at all: a SQLite or Drive backend has no
 * `.md` files to watch, and a shared DB may expose no fs-level events. Where the watch *belongs*: if the
 * StorageBackend surfaced its own change stream (see the planned CachingStorageBackend — a change-feed that
 * is fs.watch for filesystem, the Changes API for Drive, LISTEN/NOTIFY for a DB, or a plain TTL when the
 * backend can offer nothing), this plugin would collapse to just the `.md`→skill transform driven by that
 * stream, with zero `node:fs` here. The catalogue itself already reads straight from the store on every
 * call, so nothing below is needed to keep any in-memory view fresh — only the ingestion is real, and even
 * its liveness is properly the backend's job.
 *
 * It is KEPT rather than deleted so the alternative — consumer-side filesystem watching — stays visible in
 * the tree as the thing NOT to reach for, sitting next to the backend-owned approach it should defer to.
 */
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
  if (await manager.get(name) !== undefined) return;

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
