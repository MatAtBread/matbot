import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolContext, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    find_fact:         ToolContract<string[] | null,            { question: string; terms: { term: string; context?: string }[]; provider?: string }>;  // matching facts, or null
    contextual_search: ToolContract<{ name: string; content: string }, { terms: { term: string; context?: string }[] }>;                                // a whole knowledge document to read
  }
}

export function createRumsfeldPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async setup(services: MatbotMachine) {
      const executor: ToolExecutor<ToolResultOf<'contextual_search'>> = {
        async *execute(input: unknown, ctx: ToolContext) {
          const { terms } = input as { terms: Array<{ term: string; context?: string }> };

          if (terms.length === 0) {
            yield { type: 'error', message: 'No search terms provided.' };
            return;
          }

          const results = await services.KnowledgeIndex.search(terms, ctx.signal);

          if (results.length === 0) {
            yield { type: 'error', message: 'There is no skill available for the requested operation.' };
            return;
          }

          const best = results[0]!;
          yield { type: 'result', value: { name: best.entities[0] ?? best.id, content: best.content } };
        },
      };

      services.tools.register({
        name:        'contextual_search',
        description: `Load context for an unknown concept, system, term, or entity - returns a whole knowledge document to read.

      For a single specific fact, attribute, property or datum (such as a city, a URL, a date) rather than a document, use find_fact instead.
      Use this regardless of any facts you already know about the term — partial knowledge is not a reason to use find_fact.
      If unsure whether the question asks for a single attribute or about the entity itself, use contextual_search: a full entry can be summarised, but a single extracted fact cannot be un-flattened.

      Examples:
        - Is <unknown> currently working?
        - Tell me about <unknown>'s <unknown>.
        - Use your skill about <unknown>.
        - <unknown> said to <unknown> that <unknown> is broken.
        - The <unknown> is arriving for <unknown>'s birthday.

      Use when you encounter an "unknown" concept, system, term, entity, person or domain you lack specific context about - a named system you haven't
      been trained on, user-specific preferences, personal information, a specialised topic or other subject the user assumes you know about.

      Use this tool early and as a higher priority than external searches as it is more likely to yield domain specific results than a general search.
      Use this tool in preference to guessing, hallucinating, confabulating or making assumptions about what the unknown term might refer to.
      Only ask for more information about the unknown term if you have already tried to find context using the term as a search query, and that search did not return any relevant results.

      Markers of "unknown" terms are:
      - use of definite articles, demonstratives or possessives ("the", "my", "his", "that", "Fred's") even if the noun is common, for example "my Volvo" isn't a reference to Volvo's in general, it's about the user's specific car which they assume you have information about.
      - words that are clearly novel proper nouns or nouns used in a non-standard or domain-specific way, for example "the Xmit system" or "What does Xmit say?" ("Xmit" is an example of a novel proper noun).
      - when the user directly uses the term 'skill' in their query, for example "Use your skill about <unknown> to do <unknown>".
      - Deictic words such as "here", "there", "the other one", "home" which imply contextual knowledge, but none was present.

      Each term must be SPECIFIC enough to identify a particular thing - a proper noun, a named system, or a personal identifier. Strip qualifiers from a named entity ("my Volvo" → "Volvo"; "Fred's car" → "Fred" and "car" as separate terms), but do NOT collapse a query down to a bare generic noun: searching a common word like "location", "weather" or "car" on its own matches any document that merely discusses that topic - including procedures about it - rather than the specific fact you need.
      When the unknown is deictic or self-referential - "here", "home", "where am I?", "my location" - the thing you actually lack context about is the USER, not the common noun. Search for the user's own identifier (their name if you know it, otherwise terms like "user", "profile", "home") so you retrieve their stored personal facts, not material that merely mentions the concept.
      Always include the contextual phrase or sentence each term was mentioned in.`,
        inputSchema: {
          type:     'object',
          required: ['terms'],
          properties: {
            terms: {
              type:  'array',
              items: {
                type:        'object',
                properties:  {
                  term:    { type: 'string' },
                  context: { type: 'string' },
                },
                description: 'A list of unknown concepts, systems, terms, entities or domains and their immediate context.',
              },
            },
          },
        },
        executor,
      });

      const findFactExecutor: ToolExecutor<ToolResultOf<'find_fact'>> = {
        async *execute(input: unknown, ctx: ToolContext) {
          const { question, terms, provider: explicitProvider } =
            input as { question?: string; terms?: Array<{ term: string; context?: string }>; provider?: string };

          if (!question || typeof question !== 'string') {
            yield { type: 'error', message: 'Parameter "question" (the specific fact you want) is required.' };
            return;
          }
          if (!Array.isArray(terms) || terms.length === 0) {
            yield { type: 'error', message: 'Parameter "terms" (search keys locating the fact) is required.' };
            return;
          }

          // Prefer the caller's provider; fall back to any configured one so a tool that invokes
          // find_fact without threading ctx.provider still works rather than hard-failing.
          const provider = explicitProvider || ctx.provider || [...services.providers.keys()][0];
          if (!provider) {
            yield { type: 'error', message: 'No provider configured to extract the fact.' };
            return;
          }

          const results = await services.KnowledgeIndex.search(terms, ctx.signal);
          if (results.length === 0) {
            yield { type: 'result', value: null };
            return;
          }

          // Read across the top matches, not just the best one: the fact may live in a lower-ranked
          // entry (the user's profile can rank below a how-to that merely mentions the topic). Cap the
          // count and per-entry length so the extraction prompt stays bounded.
          const considered = results.slice(0, 5);
          const knowledgeEntries = considered
            .map(e => `## ${e.entities[0] ?? e.id}\n${e.content.slice(0, 6000)}`)
            .join('\n\n');

          yield { type: 'progress', pct: 50, message: `Reading ${considered.length} source(s)...` };

          const res = await services.singleTurn({
            provider,
            system: `Answer the specific question below using ONLY the supplied knowledge entries.
Extract the precise fact(s) that answer the question. Return ONLY the bare answer - no narrative, no context, no prose,
never copy the original entry text if it contains more than the answer.
Multiple answers are permitted and each MUST be a separate array element.
If the supplied entries do not contain a factual answer to the question, return \`null\` for the result.
Never guess, infer, or fall back on outside knowledge - the source must be in the supplied entries.
Reply with JSON only, no prose: {"result": {"fact": string, "source": string}[] | null}`,
            prompt: `Question: ${question}\n\n--- KNOWLEDGE ENTRIES ---\n${knowledgeEntries}\n--- END KNOWLEDGE ENTRIES ---`,
            signal: ctx.signal,
          });

          try {
            const m = res.text.match(/\{[\s\S]*\}/);
            const parsed = m ? JSON.parse(m[0]) as {"result": {"fact": string, "source": string}[] | null} : null;
            if (parsed?.result?.length) {
              yield {
                type: 'result',
                value: parsed.result.map(e => e.fact)
              };
              return;
            }
          } catch { /* unparseable - treat as not found */ }

          yield { type: 'result', value: null };
          return ;
        },
      };

      services.tools.register({
        name: 'find_fact',
        description: `Retrieve a single fact, attribute, datum or property about the specified terms from stored knowledge. Use contextual_search if you want a whole document or richer context rather than a single specific fact.

        The results are bounded to a single domain:
        - a personal detail such as a user's home city or birthday,
        - a URL for the specified search terms,
        - a configured threshold or numeric value
        - any single piece of information that has been stored.

        If unsure whether the question asks for a single attribute or about the entity itself, use contextual_search: a full entry can be summarised, but a single extracted fact cannot be un-flattened.

        Whenever a request turns on some fact that might be recorded, this can likely answer it.

        It searches the index, reads across the best matches (the fact may not be in the top-ranked entry), and returns just the answers as an array of strings - or null if the knowledge doesn't contain it. It never invents an answer.

        Provide "question" (the fact sought, e.g. "the user's home city") and "terms" (specific search keys that locate it - proper nouns, named systems, or personal identifiers; for a personal or deictic fact, search the
        user's name or "user"/"profile", not a bare generic noun). Returns string[] or null. If the responseis nuill, contextual_search can be used to read the full entry and see if it contains the fact.`,
        inputSchema: {
          type: 'object',
          required: ['question', 'terms'],
          properties: {
            question: { type: 'string', description: 'The specific fact you need, phrased as a question or noun phrase.' },
            terms: {
              type: 'array',
              items: { type: 'object', properties: { term: { type: 'string' }, context: { type: 'string' } } },
              description: 'Specific search keys locating the fact, each with the phrase it was mentioned in.',
            },
            provider: { type: 'string', description: 'Optional extraction provider. Defaults to the turn provider.' },
          },
        },
        executor: findFactExecutor,
      });
    },
  };
}

export const plugin: MatbotPluginSpec = createRumsfeldPlugin();
