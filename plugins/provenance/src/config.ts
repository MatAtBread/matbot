import type { MatbotMachine, Tool, ToolContext, ToolContract, ToolExecutor, ToolResultOf } from '@matatbread/matbot-plugin-api';

import { CLASSIFIER_PROVIDER_KEY, IGNORE_TOOLS_KEY, DEFAULT_IGNORE_TOOLS } from './keys.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    provenance_config:
      | ToolContract<{ classifierProvider: string | null; ignoreTools: string[]; ignoreToolsDefault: string[]; available: string[] }, { action: 'get' }>
      | ToolContract<{ classifierProvider?: string | null; ignoreTools?: string[] },                                                 { action: 'set'; provider?: string; ignoreTools?: string[] }>
      | ToolContract<{ classifierProvider: null; ignoreTools: null },                                                                { action: 'clear' }>;
  }
}

/**
 * Configuration for the provenance subsystem. Two settings:
 *
 *   `classifierProvider` — which provider READS the extracts for `determine_provenance`. An alias for
 *   an already-configured provider, not a new one: unset, the reading relays through the current
 *   turn's own model, so the tool works with zero config. Resolved per call. Deliberately cannot
 *   configure the cold probe — that call re-asks the model which produced the answer, so a different
 *   model would answer a different question, and the probe is hard-wired to the turn's provider.
 *
 *   `ignoreTools` — tool names whose output is excluded from the search pool. Used to suppress
 *   verbose tools whose output is not observation of the world, and to prevent `determine_provenance`
 *   from citing its own prior verdicts as evidence for the claims those verdicts were about. When
 *   unset the coded default (`DEFAULT_IGNORE_TOOLS`) applies; set to an empty array to include
 *   everything.
 */
export function createProvenanceConfigTool(services: MatbotMachine): Tool<ToolResultOf<'provenance_config'>> {
  const executor: ToolExecutor<ToolResultOf<'provenance_config'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
      const args      = input as { action?: string; provider?: string; ignoreTools?: unknown };
      const settings  = services.settings();
      const available = [...services.providers.keys()];
      switch (args.action) {
        case 'get': {
          const pinned  = await settings.get<string>(CLASSIFIER_PROVIDER_KEY);
          const ignored = await settings.get<string[]>(IGNORE_TOOLS_KEY);
          yield {
            type:  'result',
            value: {
              classifierProvider:  pinned ?? null,
              ignoreTools:         ignored ?? [...DEFAULT_IGNORE_TOOLS],
              ignoreToolsDefault:  [...DEFAULT_IGNORE_TOOLS],
              available,
            },
          };
          return;
        }
        case 'set': {
          if (args.provider === undefined && args.ignoreTools === undefined) {
            yield { type: 'error', message: 'action "set" requires at least one of "provider" or "ignoreTools".' };
            return;
          }
          const changed: { classifierProvider?: string | null; ignoreTools?: string[] } = {};
          if (args.provider !== undefined) {
            if (!args.provider) { yield { type: 'error', message: '"provider" must be a non-empty string.' }; return; }
            if (!services.providers.has(args.provider)) {
              yield { type: 'error', message: `Unknown provider "${args.provider}". Configured providers: ${available.join(', ') || '(none)'}.` };
              return;
            }
            await settings.set(CLASSIFIER_PROVIDER_KEY, args.provider);
            changed.classifierProvider = args.provider;
          }
          if (args.ignoreTools !== undefined) {
            if (!Array.isArray(args.ignoreTools) || !args.ignoreTools.every(s => typeof s === 'string')) {
              yield { type: 'error', message: '"ignoreTools" must be an array of strings.' };
              return;
            }
            await settings.set(IGNORE_TOOLS_KEY, args.ignoreTools);
            changed.ignoreTools = args.ignoreTools;
          }
          yield { type: 'result', value: changed };
          return;
        }
        case 'clear': {
          await settings.delete(CLASSIFIER_PROVIDER_KEY);
          await settings.delete(IGNORE_TOOLS_KEY);
          yield { type: 'result', value: { classifierProvider: null, ignoreTools: null } };
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
      'Configure the provenance subsystem. Two settings: `classifierProvider` — which configured ' +
      'provider reads the located extracts for `determine_provenance` (unset: uses the current ' +
      "turn's own provider; set to pin a small/fast model; never affects the cold probe, which " +
      "always re-asks the turn's own model). `ignoreTools` — tool names whose output is excluded " +
      'from the search pool (unset: applies the coded default `["determine_provenance"]`, which ' +
      'prevents this tool citing its own prior verdicts as evidence; set to an empty array to ' +
      'include everything). `get` reports the current values, the coded default for `ignoreTools`, ' +
      'and available provider names. `set` takes `provider` and/or `ignoreTools` (at least one). ' +
      '`clear` resets both.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:      { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        provider:    { type: 'string', description: 'Name of an already-configured provider — for "set".' },
        ignoreTools: { type: 'array', items: { type: 'string' }, description: 'Tool names to exclude from the search pool — for "set". Pass [] to include every tool.' },
      },
    },
    executor,
  };
}
