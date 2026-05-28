import { readFile } from 'node:fs/promises';
import type { SkillEntry } from './types.js';

export async function readSkillContent(entry: SkillEntry): Promise<string> {
  const { contentRef } = entry;
  if (contentRef.kind !== 'file') {
    throw new Error(`Cannot read skill "${entry.name}": contentRef kind "${contentRef.kind}" is not supported`);
  }
  return readFile(contentRef.path, 'utf8');
}
