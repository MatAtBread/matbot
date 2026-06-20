import type { Tool, ToolExecutor, ToolContext, ToolEvent, MatbotServices } from '@matatbread/matbot-plugin-api';

/**
 * Exposes {@link MatbotServices.singleTurn} to the model: a one-shot completion against a configured
 * provider, returning its reply. The intended use is consulting another model (e.g. a different-lineage
 * critic of the current draft, or any generation that should run on a specific provider) with a
 * well-defined interface, rather than the model improvising a bash/curl call.
 *
 * `provider` is optional: omitted, the call runs on the current turn's provider ({@link ToolContext.provider}).
 * This is the general case — name a provider to switch models, or leave it off to relay through the
 * model already in use. It lives in core (not in any plugin) because it is the model-facing surface of
 * a core service (`singleTurn`); core is also the one cross-runtime home both the node app and the
 * browser bundle register it from — the tool-plugin barrel (where `plugin`/`provider` live) is node-only.
 */
export function createSingleTurnTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as { provider?: string; prompt?: string; system?: string };
      if (typeof args.prompt !== 'string') { yield { type: 'error', message: 'single_turn requires a string "prompt".' }; return; }
      const provider = args.provider ?? ctx.provider;
      if (!provider) {
        yield { type: 'error', message: 'single_turn needs a "provider" — none was given and there is no current turn provider to fall back to.' };
        return;
      }
      if (!services.providers.has(provider)) {
        const known = [...services.providers.keys()].join(', ') || '(none configured)';
        yield { type: 'error', message: `Unknown provider "${provider}". Configured providers: ${known}.` };
        return;
      }
      const res = await services.singleTurn({
        provider,
        prompt: args.prompt,
        signal: ctx.signal,
        ...(typeof args.system === 'string' ? { system: args.system } : {}),
      });
      yield { type: 'result', value: { text: res.text, usage: res.usage } };
    },
  };

  return {
    name: 'single_turn',
    description:
      'Run a single-turn completion against a configured provider and return its reply. This is a ' +
      'one-shot call — not your own response: you send one `prompt` (and optional `system`), and get ' +
      'back its text and token usage. Use it to consult a different model — e.g. a second, ' +
      'different-lineage model critiquing your draft, or any generation that should run on a specific ' +
      'provider. `provider` is OPTIONAL: omit it to run on the current conversation\'s model, or name ' +
      'a configured provider to switch models (list or add providers with the provider tool).\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      '{ provider?: string; prompt: string; system?: string }  // -> { text, usage: { inputTokens, outputTokens } }\n' +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['prompt'],
      properties: {
        provider: { type: 'string', description: 'Name of a configured provider to run the completion against. Optional — defaults to the current turn\'s provider.' },
        prompt:   { type: 'string', description: 'The user message to send to that provider.' },
        system:   { type: 'string', description: 'Optional system prompt for the call.' },
      },
    },
    executor,
  };
}
