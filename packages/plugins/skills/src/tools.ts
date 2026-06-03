import type { Tool, ToolExecutor, ToolContext, ToolEvent, Store } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

export function createSkillTools(
  store:  Store<SkillDoc>,
  skills: Map<string, SkillDoc>,
): readonly Tool[] {
  function normalizeAlphanum(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function headingWeight(level: number): number {
    if (level === 1) return 4;
    if (level === 2) return 2;
    return 1;
  }

  function scoreByHeadings(skill: SkillDoc, terms: Array<{ term: string }>): number {
    let score = 0;
    for (const line of skill.content.split('\n')) {
      const m = /^(#{1,3})(?!#)\s+(.+)/.exec(line);
      if (!m) continue;
      const level = m[1]!.length;
      const heading = m[2]!.toLowerCase();
      for (const { term } of terms) {
        if (heading.includes(term.toLowerCase())) score += headingWeight(level);
      }
    }
    return score;
  }

  const unknownExecutor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { terms } = input as { terms: Array<{ term: string; context: string }> };

      const allSkills = [...skills.values()];
      if (terms.length === 0 || allSkills.length === 0) {
        yield { type: 'error', message: 'There is no skill available for the requested operation.' };
        return;
      }

      // Step 1: alphanum-normalised name match — single hit wins immediately
      const nameMatches = allSkills.filter(skill => {
        const normName = normalizeAlphanum(skill.name);
        return terms.some(({ term }) => {
          const normTerm = normalizeAlphanum(term);
          return normName.includes(normTerm) || normTerm.includes(normName);
        });
      });

      if (nameMatches.length === 1) {
        const skill = nameMatches[0]!;
        yield { type: 'result', value: { name: skill.name, content: skill.content } };
        return;
      }

      // Step 2: heading-weighted score (H1=4, H2=2, H3=1)
      const candidatePool = nameMatches.length > 1 ? nameMatches : allSkills;
      const scored = candidatePool
        .map(skill => ({ skill, score: scoreByHeadings(skill, terms) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

      const [first, second] = scored;
      if (first !== undefined && (second === undefined || first.score >= second.score * 2)) {
        yield { type: 'result', value: { name: first.skill.name, content: first.skill.content } };
        return;
      }

      // Step 3: BGE reranker via Cloudflare Workers AI
      const apiKey = process.env['SKILL_RANK_API_KEY'];
      const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
      const rerankPool = scored.length > 0 ? scored.map(s => s.skill) : candidatePool;

      let leadingCandidate: ToolEvent = first
      ? { type: 'result', value: { name: first.skill.name, content: first.skill.content } }
      : { type: 'error', message: 'There is no skill available for the requested operation.' }
      if (!apiKey || !accountId || rerankPool.length === 0) {
        yield leadingCandidate;
        return;
      }

      const query = terms.map(t => t.term).join(', ');
      const contexts = rerankPool.map(s => ({ text: `${s.name}\n${s.content.slice(0, 1500)}` }));

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-reranker-base`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, contexts }),
        },
      );

      if (!response.ok) {
        yield leadingCandidate;
        return;
      }

      type RerankResult = { success: boolean; errors: Array<unknown>; messages: Array<unknown>; result: { response: Array<{ id: number; score: number }> } };
      const ranking = (await response.json()) as RerankResult;
      const best = ranking.success ? ranking.result.response.slice().sort((a, b) => b.score - a.score)[0] : undefined;

      if (best === undefined || best.id >= rerankPool.length) {
        if (leadingCandidate.type === 'error') {
          leadingCandidate.stderr = JSON.stringify(ranking.errors);
        }
        yield leadingCandidate;
      } else {
        const skill = rerankPool[best.id]!;
        yield { type: 'result', value: { name: skill.name, content: skill.content } };
      }
    },
  };

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
      name: 'skill_search',
      description: `Load a skill by context.

      Examples:
        - Is my <unkonwn> currently working?
        - Tell me about <unknown>.
        - Use your skill about <unknown>.
        - <unknown> said to <unknown> that <unknown> is broken.
        - The <unknown> is arriving for <unknown>'s birthday.

      Use when you encounter an "unknown" concept, system, term, entity or domain you lack specific context about — a named system you haven't
      been trained on, user-specific preferences, personal information, a specialised topic or other subject the user assumes you know about.

      Use this tool early and as a higher priority than external searches as it is more likely to yield domain specific results than a general search.
      Use this tool in preference to guessing, hallucinating, confabnulating or making assumptions about what the unknown term might refer to.
      Only ask for more information about the unknown term if you have already tried to find a relevant skill using the term as a search query, and that search did not return any relevant results.

      Markers of "unknown" terms are:
      - use of definite articles or possessives ("the", "my") even if the noun is common, for example "my Volvo" isn't a reference to Volvo's in general, it's about the user's specific car which they assume you have information about.
      - words that are clearly novel proper nouns or nouns used in an non-standard or domain-specific way, for example "the Xmit system" or "What does Xmit say?".
      - when the user directly uses the term 'skill' in their query, for example "Use your skill about <unknown> to do <unknown>".

      List the unknown terms you need more information about, together with the contextual phrase or sentence they were mentioned in.`,
      inputSchema: {
        type: 'object',
        required: ['terms'],
        properties: {
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                term: { type: 'string' },
                context: { type: 'string' }
              },
              description: 'A list of unknown concepts, systems, terms, entities or domains and their immediate context.',
            }
          }
        }
      },
      executor: unknownExecutor,
    },
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
