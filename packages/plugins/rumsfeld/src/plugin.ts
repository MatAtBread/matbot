import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices, ToolExecutor, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

export function createRumsfeldPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async setup(services: MatbotServices) {
      const executor: ToolExecutor = {
        async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const { terms } = input as { terms: Array<{ term: string; context?: string }> };

          if (terms.length === 0) {
            yield { type: 'error', message: 'No search terms provided.' };
            return;
          }

          const results = await services.knowledge.search(terms, ctx.signal);

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
        description: `Load context for an unknown concept, system, term, or entity.

      Examples:
        - Is <unknown> currently working?
        - Tell me about <unknown>.
        - Use your skill about <unknown>.
        - <unknown> said to <unknown> that <unknown> is broken.
        - The <unknown> is arriving for <unknown>'s birthday.

      Use when you encounter an "unknown" concept, system, term, entity or domain you lack specific context about — a named system you haven't
      been trained on, user-specific preferences, personal information, a specialised topic or other subject the user assumes you know about.

      Use this tool early and as a higher priority than external searches as it is more likely to yield domain specific results than a general search.
      Use this tool in preference to guessing, hallucinating, confabulating or making assumptions about what the unknown term might refer to.
      Only ask for more information about the unknown term if you have already tried to find context using the term as a search query, and that search did not return any relevant results.

      Markers of "unknown" terms are:
      - use of definite articles, demonstratives or possessives ("the", "my", "his", "that", "Fred's") even if the noun is common, for example "my Volvo" isn't a reference to Volvo's in general, it's about the user's specific car which they assume you have information about.
      - words that are clearly novel proper nouns or nouns used in a non-standard or domain-specific way, for example "the Xmit system" or "What does Xmit say?".
      - when the user directly uses the term 'skill' in their query, for example "Use your skill about <unknown> to do <unknown>".

      List the unknown terms you need more information about, together with the contextual phrase or sentence they were mentioned in.`,
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
    },
  };
}

export const plugin: MatbotPluginSpec = createRumsfeldPlugin();
