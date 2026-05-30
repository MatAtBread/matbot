import type { Tool, ToolExecutor, ToolContext, ToolEvent, Store } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

export function createSkillTools(
  store:  Store<SkillDoc>,
  skills: Map<string, SkillDoc>,
): readonly Tool[] {
  const listExecutor: ToolExecutor = {
    async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield {
        type:  'result',
        value: {
          skills: [...skills.values()].map(s => ({
            id:   s.id,
            name: s.name,
            ...(s.toolBinding !== undefined ? { toolBinding: s.toolBinding } : {}),
          })),
        },
      };
    },
  };

  const loadExecutor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { name } = input as { name: string };
      const doc = skills.get(name.toLowerCase());
      if (!doc) {
        yield { type: 'error', message: `Skill not found: "${name}"` };
        return;
      }
      yield { type: 'result', value: { name: doc.name, content: doc.content } };
    },
  };

  const saveExecutor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { name, content } = input as { name: string; content: string };
      const now = new Date().toISOString();
      const key = name.toLowerCase();
      let doc = skills.get(key);

      if (doc === undefined) {
        const newDoc: SkillDoc = {
          id:        crypto.randomUUID(),
          version:   Date.now().toString(),
          name,
          content,
          contexts:  ['global'],
          createdAt: now,
          updatedAt: now,
        };
        await store.set(newDoc.id, newDoc);
        skills.set(key, newDoc);
      } else {
        for (;;) {
          const next: SkillDoc = { ...doc, content, updatedAt: now, version: Date.now().toString() };
          const r = await store.cas(doc.id, doc.version, next);
          if (r.ok) { skills.set(key, next); break; }
          const fresh = await store.get(doc.id);
          // If concurrently deleted, just overwrite.
          if (fresh === null) { await store.set(doc.id, next); skills.set(key, next); break; }
          doc = fresh;
        }
      }

      yield { type: 'result', value: { name } };
    },
  };

  return [
    {
      name:        'skill_list',
      description: 'List all available skills by name.',
      inputSchema: { type: 'object', properties: {} },
      executor:    listExecutor,
    },
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
