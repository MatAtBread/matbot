import type { MatbotMachine, Tool, ToolContext, ToolContract, ToolExecutor, ToolResultOf } from '@matatbread/matbot-plugin-api';

import { CLASSIFIER_PROVIDER_KEY } from './keys.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    provenance_config:
      | ToolContract<{ classifierProvider: string | null; available: string[] }, { action: 'get' }>
      | ToolContract<{ classifierProvider: string },                             { action: 'set'; provider: string }>
      | ToolContract<{ classifierProvider: null },                               { action: 'clear' }>;
  }
}

/**
 * Which provider READS the extracts for `determine_provenance`. An alias for an already-configured
 * provider, not a new one: unset, the reading relays through the current turn's own model, so the tool
 * works with zero config. Resolved per call, so a change takes effect on the next one.
 *
 * It deliberately cannot configure the cold probe. That call re-asks the model which produced the
 * answer whether it asserts the claim without this context — a different model's prior answers a
 * different question, so the probe is hard-wired to the turn's provider and stays out of settings.
 */
export function createProvenanceConfigTool(services: MatbotMachine): Tool<ToolResultOf<'provenance_config'>> {
  const executor: ToolExecutor<ToolResultOf<'provenance_config'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
      const args      = input as { action?: string; provider?: string };
      const settings  = services.settings();
      const available = [...services.providers.keys()];
      switch (args.action) {
        case 'get': {
          const pinned = await settings.get<string>(CLASSIFIER_PROVIDER_KEY);
          yield { type: 'result', value: { classifierProvider: pinned ?? null, available } };
          return;
        }
        case 'set': {
          if (!args.provider) { yield { type: 'error', message: 'action "set" requires "provider".' }; return; }
          if (!services.providers.has(args.provider)) {
            yield { type: 'error', message: `Unknown provider "${args.provider}". Configured providers: ${available.join(', ') || '(none)'}.` };
            return;
          }
          await settings.set(CLASSIFIER_PROVIDER_KEY, args.provider);
          yield { type: 'result', value: { classifierProvider: args.provider } };
          return;
        }
        case 'clear': {
          await settings.delete(CLASSIFIER_PROVIDER_KEY);
          yield { type: 'result', value: { classifierProvider: null } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, set, clear.` };
      }
    },
  };

  return {
    name: 'provenance_config',
    description:
      'Configure the provenance subsystem. One setting: `classifierProvider` — which configured provider ' +
      'reads the located extracts for `determine_provenance`. It is an alias for an existing provider, ' +
      "not a new one. Unset, the reading uses the current turn's own provider; set it to pin a small/fast " +
      'model. It does NOT affect the cold probe, which always re-asks the turn\'s own model — that is the ' +
      'model whose prior is being measured. `get` reports the current pin and the available provider ' +
      'names; `set` pins one (it must already be configured — see the provider tool); `clear` reverts to ' +
      'the turn provider.',
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
