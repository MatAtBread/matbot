/**
 * The `ask_inner_voice` tool: consult a second model (the "Matbot₂" critic of the Inner voice skill)
 * and return its critique. It is a thin wrapper over the core `singleTurn` service that resolves WHICH
 * provider plays the inner voice — the `innerVoiceProvider` setting (cognition_config) if set, else the
 * current turn's own provider. Owning this here, rather than having the skill call the generic
 * `single_turn` tool with a hard-coded provider name, keeps the provider an alias the user configures
 * (no duplicate provider profile to satisfy a literal) and severs cognition's dependency on skills'
 * toolset — the Inner voice skill content carries no provider name at all.
 *
 * Falling back to the turn provider means a same-model self-critique when nothing is pinned — degraded
 * (the value is a *different-lineage* perspective) but functional. Pin a different-lineage model via
 * cognition_config to get the genuine second opinion.
 */
import type { Tool, ToolExecutor, ToolContext, ToolEvent, MatbotServices } from '@matatbread/matbot-plugin-api';

export const INNER_VOICE_PROVIDER_KEY = 'innerVoiceProvider';

export function createAskInnerVoiceTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as { prompt?: string; system?: string };
      if (typeof args.prompt !== 'string') { yield { type: 'error', message: 'ask_inner_voice requires a string "prompt".' }; return; }

      const pinned   = await services.settings().get<string>(INNER_VOICE_PROVIDER_KEY);
      const provider = (pinned !== undefined && services.providers.has(pinned)) ? pinned : ctx.provider;
      if (!provider) {
        yield { type: 'error', message: 'ask_inner_voice has no provider — none is pinned (cognition_config) and there is no current turn provider to fall back to.' };
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
    name: 'ask_inner_voice',
    description:
      'Consult the Inner voice — a second model that constructively critiques your draft response — and ' +
      'return its critique. This is a one-shot call to a SEPARATE model (not your own response): send a ' +
      '`prompt` summarising the problem and your draft, plus an optional `system` framing, and get back ' +
      'its text and token usage. Which provider answers is configured (cognition_config `innerVoiceProvider`) ' +
      "— ideally a different training lineage; absent, it uses the current turn's model. You do not name a " +
      'provider here.\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      '{ prompt: string; system?: string }  // -> { text, usage: { inputTokens, outputTokens } }\n' +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The problem summary and your draft response for the inner voice to critique.' },
        system: { type: 'string', description: 'Optional system prompt framing the inner voice (e.g. the Matbot₂ instructions).' },
      },
    },
    executor,
  };
}

export function createCognitionConfigTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args      = input as { action?: string; provider?: string };
      const settings  = services.settings();
      const available = [...services.providers.keys()];
      switch (args.action) {
        case 'get': {
          const pinned = await settings.get<string>(INNER_VOICE_PROVIDER_KEY);
          yield { type: 'result', value: { innerVoiceProvider: pinned ?? null, available } };
          return;
        }
        case 'set': {
          if (!args.provider) { yield { type: 'error', message: 'action "set" requires "provider".' }; return; }
          if (!services.providers.has(args.provider)) {
            yield { type: 'error', message: `Unknown provider "${args.provider}". Configured providers: ${available.join(', ') || '(none)'}.` };
            return;
          }
          await settings.set(INNER_VOICE_PROVIDER_KEY, args.provider);
          yield { type: 'result', value: { innerVoiceProvider: args.provider } };
          return;
        }
        case 'clear': {
          await settings.delete(INNER_VOICE_PROVIDER_KEY);
          yield { type: 'result', value: { innerVoiceProvider: null } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, set, clear.` };
      }
    },
  };

  return {
    name: 'cognition_config',
    description:
      'Configure the cognition subsystem. Currently one setting: `innerVoiceProvider` — which configured ' +
      'provider answers ask_inner_voice (the Inner voice critic). It is an alias for an existing provider, ' +
      "not a new one; ideally a DIFFERENT training lineage than your main model. Unset, the inner voice " +
      "uses the current turn's own model (same-lineage, so degraded). `get` reports the current pin and " +
      'the available provider names; `set` pins one (it must already be configured — see the provider ' +
      'tool); `clear` reverts to the turn provider.\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      "type CognitionConfig =\n" +
      "  | { action: 'get' }                       // -> { innerVoiceProvider: string | null, available }\n" +
      "  | { action: 'set'; provider: string }     // pin a provider -> { innerVoiceProvider }\n" +
      "  | { action: 'clear' };                     // revert to the turn provider -> { innerVoiceProvider: null }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:   { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        provider: { type: 'string', description: 'Name of an already-configured provider — required for "set".' },
      },
    },
    executor,
  };
}
