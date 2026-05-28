import { watch, readdir } from 'node:fs/promises';
import path from 'node:path';
import { makeSkillEntry } from './types.js';
import type { SkillEntry } from './types.js';

function mdNameToSkillName(filename: string): string {
  return path.basename(filename, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function scanSkillDir(dir: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return entries;
  }
  for (const f of files) {
    if (f.endsWith('.md')) {
      entries.push(makeSkillEntry(path.join(dir, f), mdNameToSkillName(f)));
    }
  }
  return entries;
}

async function *pollSkillDir(
  dir:        string,
  signal:     AbortSignal,
  intervalMs: number,
): AsyncIterable<SkillEntry> {
  const seen = new Set<string>();

  while (!signal.aborted) {
    const current = await scanSkillDir(dir);
    for (const entry of current) {
      const ref = entry.contentRef;
      if (ref.kind !== 'file') continue;
      if (!seen.has(ref.path)) {
        seen.add(ref.path);
        yield entry;
      }
    }
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

/**
 * Yields a SkillEntry for every .md file found in `dir`, and for each
 * subsequently created or modified .md file while the signal is live.
 *
 * Uses fs.promises.watch (Node 22+) and falls back to polling on failure.
 */
export async function *watchSkillDir(
  dir:     string,
  signal:  AbortSignal,
  pollMs = 5_000,
): AsyncIterable<SkillEntry> {
  for (const entry of await scanSkillDir(dir)) {
    yield entry;
  }

  try {
    for await (const event of watch(dir, { signal })) {
      if (!event.filename?.endsWith('.md')) continue;
      yield makeSkillEntry(path.join(dir, event.filename), mdNameToSkillName(event.filename));
    }
  } catch (e) {
    if (signal.aborted) return;
    yield* pollSkillDir(dir, signal, pollMs);
  }
}
