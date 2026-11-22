/**
 * LLM-backed {@link Clusterer} and {@link SkillWriter}.
 *
 * Clustering is one `singleTurn` call over the whole backlog: a few hundred short facts is a few thousand
 * tokens, and grouping needs every fact in view at once, which per-fact calls cannot give. Facts are shown
 * by a short handle (`f12`) rather than their UUID: shorter to read and to write back, and a handle the
 * model mangles is simply unknown, where a mangled UUID can collide. The pipeline validates what comes
 * back, so a malformed group is dropped there; a reply that does not parse throws.
 *
 * Both work to {@link SKILL_DEFINITION}: a new group must come with a message that would reach it, and what
 * is not skill material is grouped nowhere and left out of the document. Neither retires a fact: one call
 * judging hundreds of facts at once discarded sound ones in blocks when tried, so retiring stays with the
 * ranker, which judges one fact at a time.
 *
 * Writing is one call per new group, returning markdown rather than JSON: the document is the whole answer.
 */

import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { Clusterer, FactGroup, SkillWriter } from './ranker.js';
import { SKILL_DEFINITION } from './skillDefinition.js';
import type { RememberedFact } from './types.js';

const CLUSTER_SYSTEM = `
You organise an assistant's long-term memory. You are given facts the assistant remembered that no existing skill took, the existing skills, and the names of skills already rejected.
${SKILL_DEFINITION}

Sort the facts:
- Group the facts by subject, where each group would make a coherent skill. Facts that are not skill material go in no group.
- A group whose facts belong in an EXISTING skill gets that skill's exact name as "home". Use this only when the skill plainly covers the subject.
- Otherwise "home" is null and the group needs a new skill. Give it a short title-case name, as a user would name the subject, and a one-sentence "scope". Its "asked" is one message a user might plausibly send that would call for this skill, naming the subject as the user would. A message the assistant's own software would answer (its tools, settings, providers, versions) does not count. If you cannot write that message, it is not a skill: leave those facts out.
- Never propose a new skill whose name or subject matches a rejected one.
- A group is one subject. Never join distinct subjects to make a group bigger; a fact that fits a group only loosely stays out of it.
- Leave a fact out if it fits no group. Leaving facts out is normal. A fact goes in at most one group.

Return ONLY a JSON object on the last line, in this shape:
{ "groups": [ { "name": "", "scope": "", "asked": "", "home": null, "members": ["f1", "f2"] } ] }
"members" lists the handles shown before each fact. Do not wrap it in code fences.`;

const WRITER_SYSTEM = `
You write a skill: a markdown document an assistant reads when a user's message names its subject. You are given its name, its scope, a message that would call for it, and the facts it is written from.
${SKILL_DEFINITION}

- Start with "# <name>", then one or two sentences saying what the subject is, naming it precisely as a user would. The assistant finds a skill by the terms in it, so add no general terms to make it easier to find.
- Organise the facts under "##" headings by aspect of the subject, as terse bullets or short paragraphs. Use a table where facts share a shape (devices and addresses, dates and amounts).
- Leave out any fact that is not skill material. Fold facts that say the same thing into one statement. Add nothing the facts do not say.
- Where two facts contradict each other, keep both and put "(!) Note:" before the second, saying what conflicts.

Return only the markdown, with no code fences around it. If none of the facts is skill material, return exactly NONE instead.`;

function extractJsonObject(text: string): string | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : undefined;
}

export function createLlmClusterer(services: MatbotMachine, provider: string): Clusterer {
  return {
    async cluster(facts, skills, rejected, signal) {
      if (facts.length === 0) return [];
      const handles = new Map(facts.map((f, i) => [`f${i + 1}`, f.id]));
      const roster  = skills.map(s => `- ${s.name}: ${s.summary}`).join('\n');
      const listed  = facts.map((f, i) => `f${i + 1}: ${f.fact.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
      const prompt  =
        `Existing skills:\n${roster || '(none)'}\n\n` +
        `Rejected skills: ${rejected.length > 0 ? rejected.join('; ') : '(none)'}\n\n` +
        `Facts (${facts.length}):\n${listed}`;
      const res = await services.singleTurn({ provider, signal, system: CLUSTER_SYSTEM, prompt });
      const block = extractJsonObject(res.text);
      let parsed: unknown;
      try { parsed = block === undefined ? undefined : JSON.parse(block); } catch { parsed = undefined; }
      const groups = (parsed as { groups?: unknown } | undefined)?.groups;
      if (!Array.isArray(groups)) throw new Error(`clusterer reply did not parse; first 200 chars: ${res.text.slice(0, 200)}`);
      const ids = (hs: unknown): string[] => (Array.isArray(hs) ? hs : []).flatMap(h => {
        const id = typeof h === 'string' ? handles.get(h.trim()) : undefined;
        return id === undefined ? [] : [id];
      });
      const out: FactGroup[] = [];
      for (const g of groups as Array<Record<string, unknown>>) {
        if (typeof g?.['name'] !== 'string' || !Array.isArray(g['members'])) continue;
        out.push({
          name:    g['name'].trim(),
          scope:   typeof g['scope'] === 'string' ? g['scope'] : '',
          asked:   typeof g['asked'] === 'string' ? g['asked'].trim() : '',
          home:    typeof g['home'] === 'string' && g['home'].trim() !== '' ? g['home'].trim() : null,
          members: ids(g['members']),
        });
      }
      return out;
    },
  };
}

export function createLlmSkillWriter(services: MatbotMachine, provider: string): SkillWriter {
  return {
    async write(group: FactGroup, facts: readonly RememberedFact[], signal: AbortSignal): Promise<string | undefined> {
      const prompt =
        `Name: ${group.name}\nScope: ${group.scope}\nA message that would call for it: ${group.asked}\n\n` +
        `Facts (${facts.length}):\n${facts.map(f => `- ${f.fact}`).join('\n')}`;
      const res  = await services.singleTurn({ provider, signal, system: WRITER_SYSTEM, prompt });
      const text = res.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1').trim();
      if (text === '') throw new Error('the skill writer returned nothing');
      return /^NONE\.?$/.test(text) ? undefined : text;
    },
  };
}
