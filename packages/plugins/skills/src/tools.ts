import type { Tool, ToolExecutor, ToolContext, ToolEvent, Store, KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

export function skillToKnowledgeEntry(doc: SkillDoc): KnowledgeEntry {
  const nameLower  = doc.name.toLowerCase();
  const nameTokens = nameLower.split(/[\s\-_]+/).filter(t => t.length > 1);
  return {
    id:        doc.id,
    version:   doc.version,
    entities:  [...new Set([doc.name, nameLower, ...nameTokens])],
    tags:      doc.tags ?? [],
    summary:   doc.content.slice(0, 500),
    content:   doc.content,
    source:    { type: 'skill', uuid: doc.id },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// The precise per-action contract. JSON Schema can't express "content required only for save"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SkillInput =
  | { action: 'list' }
  | { action: 'load';   name: string }
  | { action: 'save';   name: string; content: string }
  | { action: 'delete'; name: string };

export function createSkillTools(
  store:     Store<SkillDoc>,
  skills:    Map<string, SkillDoc>,
  knowledge: KnowledgeIndex,
): readonly Tool[] {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as Partial<SkillInput> & { action?: string };

      switch (args.action) {
        case 'list': {
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
          return;
        }

        case 'load': {
          const { name } = args as Extract<SkillInput, { action: 'load' }>;
          if (!name) { yield { type: 'error', message: 'action "load" requires "name".' }; return; }
          const doc = skills.get(name.toLowerCase());
          if (!doc) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          yield { type: 'result', value: { name: doc.name, content: doc.content } };
          return;
        }

        case 'save': {
          const { name, content } = args as Extract<SkillInput, { action: 'save' }>;
          if (!name) { yield { type: 'error', message: 'action "save" requires "name".' }; return; }
          if (content === undefined) { yield { type: 'error', message: 'action "save" requires "content".' }; return; }
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
            void knowledge.index(skillToKnowledgeEntry(newDoc));
          } else {
            for (;;) {
              const next: SkillDoc = { ...doc, content, updatedAt: now, version: Date.now().toString() };
              const r = await store.cas(doc.id, doc.version, next);
              if (r.ok) { skills.set(key, next); void knowledge.index(skillToKnowledgeEntry(next)); break; }
              const fresh = await store.get(doc.id);
              if (fresh === null) { await store.set(doc.id, next); skills.set(key, next); void knowledge.index(skillToKnowledgeEntry(next)); break; }
              doc = fresh;
            }
          }

          yield { type: 'result', value: { name } };
          return;
        }

        case 'delete': {
          const { name } = args as Extract<SkillInput, { action: 'delete' }>;
          if (!name) { yield { type: 'error', message: 'action "delete" requires "name".' }; return; }
          const key = name.toLowerCase();
          const doc = skills.get(key);
          if (doc === undefined) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          await store.delete(doc.id, doc.version);
          skills.delete(key);
          yield { type: 'result', value: { name: doc.name } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, load, save, delete.` };
      }
    },
  };

  return [
    {
      name: 'skill_action',
      description:
        'Manage skills — named, reusable markdown playbooks (procedures, conventions, reference ' +
        'notes) the assistant stores and recalls on demand. A skill is keyed by name (case-insensitive) ' +
        'and holds markdown content; the skills system may also surface a relevant skill automatically. ' +
        'Use this tool to list skills, load one\'s full content, create or update one, or delete one.\n\n' +
        'Parameters depend on `action` (TypeScript):\n' +
        '```ts\n' +
        'type SkillAction =\n' +
        "  | { action: 'list' }                            // -> { skills: [{ id, name, toolBinding? }] }\n" +
        "  | { action: 'load';   name: string }            // -> { name, content }\n" +
        "  | { action: 'save';   name: string; content: string }  // create or update -> { name }\n" +
        "  | { action: 'delete'; name: string };           // -> { name }\n" +
        '```',
      inputSchema: {
        type:       'object',
        required:   ['action'],
        properties: {
          action:  { type: 'string', enum: ['list', 'load', 'save', 'delete'], description: 'The operation to perform.' },
          name:    { type: 'string', description: 'Skill name (case-insensitive). Required for load/save/delete.' },
          content: { type: 'string', description: 'Skill content in markdown — required for action "save".' },
        },
      },
      executor,
    },
  ];
}
