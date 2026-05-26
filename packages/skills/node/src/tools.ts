import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolExecutor, ToolContext, ToolEvent } from '@matbot/plugin-api';
import type { SkillEntry } from '@matbot/skills-base';

interface SkillLoadInput {
  name: string;
}

interface SkillSaveInput {
  name:    string;
  content: string;
}

function skillNameToFilename(name: string): string {
  return `${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.md`;
}

export function createSkillTools(
  skillsDir: string,
  getSkills: () => SkillEntry[],
): readonly Tool[] {
  const loadExecutor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { name } = input as SkillLoadInput;
      const lower = name.toLowerCase();
      const match = getSkills().find(s => s.name.toLowerCase() === lower);

      if (!match) {
        yield { type: 'error', message: `Skill not found: "${name}"` };
        return;
      }

      const { contentRef } = match;
      if (contentRef.kind !== 'file') {
        yield { type: 'error', message: `Skill "${name}" has no file content` };
        return;
      }

      try {
        const content = await readFile(contentRef.path, 'utf8');
        yield { type: 'result', value: { name: match.name, content } };
      } catch (e) {
        yield { type: 'error', message: `Failed to read skill "${name}": ${String(e)}` };
      }
    },
  };

  const saveExecutor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { name, content } = input as SkillSaveInput;
      const filePath = path.join(skillsDir, skillNameToFilename(name));

      try {
        await mkdir(skillsDir, { recursive: true });
        await writeFile(filePath, content, 'utf8');
        yield { type: 'result', value: { name, path: filePath } };
      } catch (e) {
        yield { type: 'error', message: `Failed to save skill "${name}": ${String(e)}` };
      }
    },
  };

  return [
    {
      name:        'skill_load',
      description: 'Load the full markdown content of a named skill.',
      inputSchema: {
        type:       'object',
        required:   ['name'],
        properties: {
          name: { type: 'string', description: 'Exact skill name (case-insensitive).' },
        },
      },
      executor: loadExecutor,
    },
    {
      name:        'skill_save',
      description: 'Create or update a skill with the given name and markdown content.',
      requires:    ['filesystem'],
      inputSchema: {
        type:       'object',
        required:   ['name', 'content'],
        properties: {
          name:    { type: 'string', description: 'Skill name.' },
          content: { type: 'string', description: 'Skill content in markdown.' },
        },
      },
      executor: saveExecutor,
    },
  ];
}
