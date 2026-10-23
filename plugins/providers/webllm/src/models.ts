import type { Tool, ToolContract, ToolResultOf } from '@matatbread/matbot-plugin-api';
import { resident } from './adapter.js';
import { appConfig, chatModels, closestModels, gpuFeatures, library } from './webllm.js';

export interface WebLLMModelSummary {
  id:             string;
  /** GPU memory the model needs, in MB, as WebLLM records it — at its default context window. */
  vramMB?:        number;
  /** WebLLM's mark for a model that suits phones and low-memory GPUs. */
  lowResource?:   true;
  /** The context window WebLLM sets for it, where it overrides the model's own. */
  contextWindow?: number;
  /** GPU features it needs. Absent when it needs none. */
  requires?:      string[];
  /** Whether this page's GPU has every feature it needs. Absent when there is no GPU adapter to ask. */
  runsHere?:      boolean;
  /** Already downloaded into this origin's cache, so using it costs no download. */
  downloaded:     boolean;
  /** The model this provider has loaded (or is loading) right now. */
  loaded?:        true;
}

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    webllm_models:
      | ToolContract<{ models: WebLLMModelSummary[]; total: number }, { action: 'list'; query?: string; downloaded?: boolean }>
      | ToolContract<{ model: string; deleted: true },               { action: 'delete'; model: string }>;
  }
}

type Input =
  | { action: 'list'; query?: string; downloaded?: boolean }
  | { action: 'delete'; model: string };

export const webllmModelsTool: Tool<ToolResultOf<'webllm_models'>> = {
  name: 'webllm_models',
  description:
    'The models the WebLLM provider can run in this browser. Every model runs on this device\'s GPU, and '
    + 'downloads (once, often gigabytes) the first time it is used.\n\n'
    + '"list" returns them smallest first: each "id" (the value for a WebLLM provider profile\'s "model"), '
    + '"vramMB" (GPU memory needed), whether it "runsHere" (this GPU has the features it needs) and whether '
    + 'it is already "downloaded". Pass "query" to narrow by name — e.g. "qwen3" or "4b" — since the full list '
    + 'is long; "downloaded": true lists only what is already on this device. Qwen and Hermes models handle '
    + 'tool calls best; "q4f16" builds are the smaller and faster where the GPU supports them, "q4f32" the '
    + 'fallback. To switch a profile to a model, use the provider tool\'s "update" with the id.\n\n'
    + '"delete" removes a downloaded model from this device to free its storage; it downloads again if used.',
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:     { type: 'string', enum: ['list', 'delete'] },
      query:      { type: 'string', description: 'list only: words that must all appear in the model id, case-insensitively.' },
      downloaded: { type: 'boolean', description: 'list only: true for just the models already downloaded.' },
      model:      { type: 'string', description: 'delete only: the model id.' },
    },
  },
  executor: {
    async *execute(rawInput) {
      const input  = rawInput as Input;
      const now    = resident();
      const lib    = await library(now.library);
      const config = appConfig(lib, now.cache);
      const models = chatModels(lib);

      switch (input.action) {
        case 'list': {
          const words    = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const matching = models.filter(r => words.every(w => r.model_id.toLowerCase().includes(w)));
          const have     = await gpuFeatures();
          const rows = await Promise.all(matching.map(async (r): Promise<WebLLMModelSummary> => {
            const requires = r.required_features ?? [];
            return {
              id: r.model_id,
              ...(r.vram_required_MB !== undefined ? { vramMB: Math.round(r.vram_required_MB) } : {}),
              ...(r.low_resource_required ? { lowResource: true as const } : {}),
              ...(r.overrides?.context_window_size !== undefined ? { contextWindow: r.overrides.context_window_size } : {}),
              ...(requires.length > 0 ? { requires } : {}),
              ...(have ? { runsHere: requires.every(f => have.has(f)) } : {}),
              downloaded: await lib.hasModelInCache(r.model_id, config).catch(() => false),
              ...(r.model_id === now.model ? { loaded: true as const } : {}),
            };
          }));
          const shown = rows
            .filter(r => input.downloaded !== true || r.downloaded)
            .sort((a, b) => (a.vramMB ?? Infinity) - (b.vramMB ?? Infinity) || a.id.localeCompare(b.id));
          yield { type: 'result', value: { models: shown, total: models.length } };
          return;
        }
        case 'delete': {
          if (!input.model) { yield { type: 'error', message: 'action "delete" requires "model".' }; return; }
          if (!models.some(r => r.model_id === input.model)) {
            const near = closestModels(input.model, models);
            yield { type: 'error', message: `"${input.model}" is not a WebLLM model id.${near.length > 0 ? ` Closest: ${near.join(', ')}.` : ''}` };
            return;
          }
          await lib.deleteModelAllInfoInCache(input.model, config);
          yield { type: 'result', value: { model: input.model, deleted: true } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${(input as { action?: unknown }).action}". Use "list" or "delete".` };
      }
    },
  },
};
